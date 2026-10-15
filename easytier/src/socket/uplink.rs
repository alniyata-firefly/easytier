use std::{
    collections::HashMap,
    io,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, OnceLock, Weak},
};

use easytier_core::socket::SocketContext;
use socket2::{Domain, Protocol, Socket, Type};

use crate::{
    common::{
        netns::NetNS,
        uplink::{UplinkInterface, selected_interfaces, usable_unicast_address},
    },
    socket_protector::protect_native_socket,
    tunnel::common::{BindDev, apply_socket_mark, bind_socket_device},
};

#[derive(Clone, Debug)]
pub(crate) struct UplinkSource {
    pub address: SocketAddr,
    pub interface: String,
    pub ifindex: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum UplinkPortProtocol {
    Tcp,
    Udp,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct UplinkPortKey {
    namespace: String,
    protocol: UplinkPortProtocol,
    family: u8,
    port: u16,
}

/// Reuse is internal to one logical listener/pool. Prevent independent native
/// instances from accidentally joining the same kernel REUSEPORT group.
pub(crate) fn lease_uplink_port(
    context: &SocketContext,
    local: SocketAddr,
    only_v6: bool,
    protocol: UplinkPortProtocol,
) -> io::Result<Arc<()>> {
    static LEASES: OnceLock<Mutex<HashMap<UplinkPortKey, Weak<()>>>> = OnceLock::new();
    let namespace = NetNS::from_socket_context(context).run(|| -> io::Result<String> {
        #[cfg(target_os = "linux")]
        {
            Ok(std::fs::read_link("/proc/thread-self/ns/net")?
                .to_string_lossy()
                .into_owned())
        }
        #[cfg(not(target_os = "linux"))]
        {
            Ok("process".to_owned())
        }
    })?;
    let families: &[u8] = if local.is_ipv4() {
        &[4]
    } else if only_v6 {
        &[6]
    } else {
        &[4, 6]
    };
    let keys: Vec<_> = families
        .iter()
        .map(|family| UplinkPortKey {
            namespace: namespace.clone(),
            protocol,
            family: *family,
            port: local.port(),
        })
        .collect();
    let mut leases = LEASES.get_or_init(Mutex::default).lock().unwrap();
    leases.retain(|_, lease| lease.strong_count() > 0);
    if keys.iter().any(|key| {
        leases
            .get(key)
            .is_some_and(|lease| lease.strong_count() > 0)
    }) {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "uplink {protocol:?} port {} is already owned by another logical socket",
                local.port()
            ),
        ));
    }
    let lease = Arc::new(());
    for key in keys {
        leases.insert(key, Arc::downgrade(&lease));
    }
    Ok(lease)
}

pub(crate) fn normalized_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

fn subnet_match(interface: &UplinkInterface, remote: IpAddr) -> u32 {
    interface
        .addresses
        .iter()
        .filter_map(|address| {
            let ip = address.ip();
            let mask = address.netmask()?;
            match (ip, mask, remote) {
                (IpAddr::V4(ip), IpAddr::V4(mask), IpAddr::V4(remote)) => {
                    let mask = u32::from(mask);
                    ((u32::from(ip) & mask) == (u32::from(remote) & mask))
                        .then(|| mask.count_ones())
                }
                (IpAddr::V6(ip), IpAddr::V6(mask), IpAddr::V6(remote)) => {
                    let mask = u128::from(mask);
                    ((u128::from(ip) & mask) == (u128::from(remote) & mask))
                        .then(|| mask.count_ones())
                }
                _ => None,
            }
        })
        .max()
        .unwrap_or(0)
}

/// Select a source only after checking the instance's uplink inventory. Probes
/// call UDP connect without sending a datagram. Each fallback probe is pinned
/// to an allowed device, so an overlay default route cannot supply the result.
pub(crate) async fn source_for_remote(
    context: &SocketContext,
    remote: SocketAddr,
    preferred_ip: Option<IpAddr>,
    preferred_interface: Option<&str>,
    need_protect: bool,
) -> io::Result<UplinkSource> {
    let mut interfaces = selected_interfaces(context)
        .await
        .map_err(io::Error::other)?;
    let remote_ip = normalized_ip(remote.ip());
    let preferred_ip = preferred_ip
        .map(normalized_ip)
        .filter(|ip| !ip.is_unspecified());
    interfaces.retain(|interface| {
        preferred_interface.is_none_or(|name| name == interface.name)
            && preferred_ip.is_none_or(|ip| interface.addresses.iter().any(|addr| addr.ip() == ip))
            && interface.addresses.iter().any(|address| {
                address.ip().is_ipv4() == remote_ip.is_ipv4()
                    && usable_unicast_address(address.ip())
            })
    });
    if interfaces.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            format!("no allowed uplink can reach {remote} with the requested source/interface"),
        ));
    }
    interfaces.sort_by_key(|interface| std::cmp::Reverse(subnet_match(interface, remote_ip)));

    // Preserve the OS route preference when it already resolves to an allowed
    // interface, rather than selecting an arbitrary member of a manual list.
    if preferred_ip.is_none() && preferred_interface.is_none() {
        if let Ok(source) = probe_source(context, remote, None, None, need_protect).await {
            let source_ip = normalized_ip(source.ip());
            if let Some(position) = interfaces.iter().position(|interface| {
                interface
                    .addresses
                    .iter()
                    .any(|address| address.ip() == source_ip)
            }) {
                let interface = interfaces.remove(position);
                interfaces.insert(0, interface);
            }
        }
    }

    let mut last_error = None;
    for interface in interfaces {
        match probe_source(
            context,
            remote,
            Some(&interface.name),
            preferred_ip,
            need_protect,
        )
        .await
        {
            Ok(address)
                if interface
                    .addresses
                    .iter()
                    .any(|local| local.ip() == normalized_ip(address.ip())) =>
            {
                return Ok(UplinkSource {
                    address,
                    interface: interface.name,
                    ifindex: interface.index,
                });
            }
            Ok(_) => {
                last_error = Some(io::Error::new(
                    io::ErrorKind::AddrNotAvailable,
                    "route probe selected a source outside the allowed uplink",
                ))
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::NetworkUnreachable,
            format!("no allowed uplink route to {remote}"),
        )
    }))
}

async fn probe_source(
    context: &SocketContext,
    remote: SocketAddr,
    interface: Option<&str>,
    preferred_ip: Option<IpAddr>,
    need_protect: bool,
) -> io::Result<SocketAddr> {
    let netns = NetNS::from_socket_context(context);
    let socket = netns.run(|| {
        let socket = Socket::new(
            Domain::for_address(remote),
            Type::DGRAM,
            Some(Protocol::UDP),
        )?;
        apply_socket_mark(&socket, context.socket_mark).map_err(io::Error::other)?;
        Ok::<_, io::Error>(socket)
    })?;
    protect_native_socket(&socket, need_protect).await?;
    netns.run(|| {
        let local_ip = preferred_ip.unwrap_or_else(|| {
            if remote.is_ipv4() {
                IpAddr::from([0, 0, 0, 0])
            } else {
                IpAddr::from([0u16; 8])
            }
        });
        let local = SocketAddr::new(local_ip, 0);
        bind_socket_device(&socket, &local, interface.map(str::to_owned))
            .map_err(io::Error::other)?;
        socket.bind(&local.into())?;
        socket.connect(&remote.into())?;
        socket.local_addr()?.as_socket().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                "route probe returned a non-IP address",
            )
        })
    })
}

pub(crate) async fn validate_local_bind(
    context: &SocketContext,
    local: Option<SocketAddr>,
    bind_device: Option<&str>,
) -> io::Result<Option<BindDev>> {
    if context.uplink.is_none() {
        return Ok(None);
    }
    let interfaces = selected_interfaces(context)
        .await
        .map_err(io::Error::other)?;
    let explicit_device = bind_device.filter(|name| !name.is_empty());
    if explicit_device
        .is_some_and(|name| !interfaces.iter().any(|interface| interface.name == name))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socket device is not an allowed uplink",
        ));
    }
    if let Some(local) =
        local.filter(|local| !local.ip().is_unspecified() && !local.ip().is_loopback())
    {
        let interface = interfaces
            .iter()
            .find(|interface| {
                interface
                    .addresses
                    .iter()
                    .any(|address| address.ip() == normalized_ip(local.ip()))
                    && explicit_device.is_none_or(|name| name == interface.name)
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("local address {} is not on an allowed uplink", local.ip()),
                )
            })?;
        return Ok(Some(BindDev::Custom(interface.name.clone())));
    }
    Ok(explicit_device.map(|name| BindDev::Custom(name.to_owned())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_port_leases_are_released_and_isolate_protocols_and_address_families() {
        let context = SocketContext::default();
        let ipv4: SocketAddr = "0.0.0.0:9".parse().unwrap();
        let ipv6: SocketAddr = "[::]:9".parse().unwrap();
        let first = lease_uplink_port(&context, ipv4, false, UplinkPortProtocol::Udp).unwrap();
        assert_eq!(
            lease_uplink_port(&context, ipv4, false, UplinkPortProtocol::Udp)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AddrInUse
        );
        // A rejected dual-stack lease must not reserve its other family.
        assert_eq!(
            lease_uplink_port(&context, ipv6, false, UplinkPortProtocol::Udp)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AddrInUse
        );
        let v6_only = lease_uplink_port(&context, ipv6, true, UplinkPortProtocol::Udp).unwrap();
        let tcp = lease_uplink_port(&context, ipv4, false, UplinkPortProtocol::Tcp).unwrap();
        drop(first);
        let replacement =
            lease_uplink_port(&context, ipv4, false, UplinkPortProtocol::Udp).unwrap();
        drop(replacement);
        drop(v6_only);
        let dual_stack = lease_uplink_port(&context, ipv6, false, UplinkPortProtocol::Udp).unwrap();
        assert_eq!(
            lease_uplink_port(&context, ipv4, false, UplinkPortProtocol::Udp)
                .unwrap_err()
                .kind(),
            io::ErrorKind::AddrInUse
        );
        drop(dual_stack);
        drop(tcp);
    }

    #[test]
    fn mapped_ipv4_addresses_use_ipv4_inventory() {
        assert_eq!(
            normalized_ip("::ffff:192.0.2.1".parse().unwrap()),
            "192.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            normalized_ip("fd00::1".parse().unwrap()),
            "fd00::1".parse::<IpAddr>().unwrap()
        );
    }
}
