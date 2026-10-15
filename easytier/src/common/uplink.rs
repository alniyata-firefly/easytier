//! Native underlay inventory shared by discovery and socket enforcement.
//!
//! "Physical" includes a VM's hardware NIC and logical WAN devices layered on
//! such a NIC. An address being present, or having the default route, is not
//! sufficient to make an unrelated VPN an underlay.

#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::net::IpAddr;

use anyhow::{Context, bail};
use easytier_core::{
    config::uplink::{UplinkConfig, UplinkMode},
    host_inventory::{NetworkInterfaceAddress, NetworkInterfaceInfo, NetworkInterfaceInventory},
    socket::SocketContext,
};
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};

use super::netns::NetNS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UplinkInterface {
    pub name: String,
    pub index: u32,
    pub addresses: Vec<Addr>,
}

#[derive(Clone, Debug)]
struct ObservedInterface {
    interface: NetworkInterface,
    up: bool,
    automatic: bool,
    link_up: Option<bool>,
    kind: String,
}

/// Management inventory deliberately bypasses selection policy. A dedicated
/// thread owns namespace entry and then exits, so a failed namespace restore
/// can never poison a shared runtime worker.
pub(crate) async fn network_interface_inventory(
    namespace: Option<String>,
) -> anyhow::Result<NetworkInterfaceInventory> {
    #[cfg(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "windows"
    ))]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("network-inventory".to_owned())
            .spawn(move || {
                let result = inventory_in_namespace(namespace);
                let _ = sender.send(result);
            })
            .context("failed to start network inventory thread")?;
        receiver.await.context("network inventory thread failed")?
    }
    #[cfg(not(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "windows"
    )))]
    {
        Ok(NetworkInterfaceInventory {
            supported: false,
            sampled_at_unix_ms: inventory_sample_time(),
            namespace,
            interfaces: Vec::new(),
        })
    }
}

fn inventory_sample_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(any(
    all(target_os = "linux", not(target_env = "ohos")),
    target_os = "windows"
))]
fn inventory_in_namespace(namespace: Option<String>) -> anyhow::Result<NetworkInterfaceInventory> {
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    if let Some(name) = namespace.as_deref() {
        use nix::sched::{CloneFlags, setns};
        use std::path::{Component, Path};
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            bail!("invalid network namespace name");
        }
        let path = if name == super::netns::ROOT_NETNS_NAME {
            std::path::PathBuf::from("/proc/1/ns/net")
        } else {
            Path::new("/var/run/netns").join(name)
        };
        let namespace_file = std::fs::File::open(&path)
            .with_context(|| format!("failed to open network namespace {name:?}"))?;
        setns(&namespace_file, CloneFlags::CLONE_NEWNET)
            .with_context(|| format!("failed to enter network namespace {name:?}"))?;
    }
    #[cfg(target_os = "windows")]
    if namespace.is_some() {
        bail!("network namespace inventory is unsupported on this host");
    }

    let raw = NetworkInterface::show().context("failed to enumerate network interfaces")?;
    let mut interfaces = Vec::with_capacity(raw.len());
    for interface in raw {
        // Linux's observation removes tentative/deprecated IPv6 candidates.
        // Management still reports every address actually present on the NIC.
        let addresses = interface.addr.clone();
        let observed = observe_interface(interface)?;
        interfaces.push(inventory_interface(observed, addresses));
    }
    interfaces.sort_by(|left, right| {
        left.index
            .cmp(&right.index)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(NetworkInterfaceInventory {
        supported: true,
        sampled_at_unix_ms: inventory_sample_time(),
        namespace,
        interfaces,
    })
}

fn inventory_interface(observed: ObservedInterface, addresses: Vec<Addr>) -> NetworkInterfaceInfo {
    let interface = observed.interface;
    let manual_selectable =
        !interface.internal && interface.index != 0 && observed.kind != "loopback";
    let auto_eligible = manual_selectable
        && observed.automatic
        && observed.up
        && interface
            .addr
            .iter()
            .any(|address| usable_unicast_address(address.ip()));
    NetworkInterfaceInfo {
        name: interface.name,
        index: interface.index,
        addresses: addresses
            .into_iter()
            .map(|address| NetworkInterfaceAddress {
                address: address.ip(),
                prefix_length: address
                    .netmask()
                    .and_then(|mask| super::network::ip_mask_to_prefix(mask).ok().map(u32::from)),
            })
            .collect(),
        kind: observed.kind,
        up: observed.link_up,
        auto_eligible,
        manual_selectable,
    }
}

/// Link-local addresses cannot be published without a peer-specific scope.
/// Private LAN addresses and IPv6 ULA remain valid on an allowed uplink.
pub(crate) fn usable_unicast_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_multicast()
                && !ip.is_link_local()
                && !ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            !ip.is_unspecified()
                && !ip.is_loopback()
                && !ip.is_multicast()
                && !ip.is_unicast_link_local()
                && ip.to_ipv4_mapped().is_none()
        }
    }
}

/// A policy must be explicitly present. Generic non-instance host sockets keep
/// their previous behavior at their call site instead of silently opting in.
pub(crate) async fn selected_interfaces(
    context: &SocketContext,
) -> anyhow::Result<Vec<UplinkInterface>> {
    let policy = context
        .uplink
        .clone()
        .context("uplink inventory requires an explicit policy")?;
    let net_ns = NetNS::from_socket_context(context);
    tokio::task::spawn_blocking(move || {
        net_ns.run(|| select_interfaces(&policy, observe_interfaces()?))
    })
    .await
    .context("uplink inventory task failed")?
}

pub(crate) async fn interface_for_local_ip(
    context: &SocketContext,
    ip: IpAddr,
) -> anyhow::Result<UplinkInterface> {
    selected_interfaces(context)
        .await?
        .into_iter()
        .find(|interface| interface.addresses.iter().any(|address| address.ip() == ip))
        .with_context(|| {
            format!("source address {ip} does not belong to an available allowed uplink")
        })
}

fn select_interfaces(
    policy: &UplinkConfig,
    observed: Vec<ObservedInterface>,
) -> anyhow::Result<Vec<UplinkInterface>> {
    policy.validate()?;
    let manual = matches!(policy.mode, UplinkMode::Manual);
    let mut selected = Vec::new();
    // Manual order is intentional and stable; automatic order follows OS
    // interface indices rather than incidental directory enumeration order.
    let mut observed = observed;
    if manual {
        observed.sort_by_key(|item| {
            policy
                .interfaces
                .iter()
                .position(|name| *name == item.interface.name)
                .unwrap_or(usize::MAX)
        });
    } else {
        observed.sort_by_key(|item| item.interface.index);
    }
    for item in &observed {
        let interface = &item.interface;
        if manual && !policy.interfaces.contains(&interface.name) {
            continue;
        }
        if !manual && !item.automatic {
            continue;
        }
        let addresses: Vec<_> = interface
            .addr
            .iter()
            .copied()
            .filter(|addr| usable_unicast_address(addr.ip()))
            .collect();
        if !item.up || interface.internal || interface.index == 0 || addresses.is_empty() {
            tracing::debug!(interface = %interface.name, "selected uplink is down, loopback, or has no usable unicast address");
            continue;
        }
        selected.push(UplinkInterface {
            name: interface.name.clone(),
            index: interface.index,
            addresses,
        });
    }
    if manual {
        for name in &policy.interfaces {
            if !observed
                .iter()
                .any(|interface| interface.interface.name == *name)
            {
                bail!("selected uplink interface {name:?} is unavailable");
            }
        }
    }
    if selected.is_empty() {
        bail!("no available allowed uplink interface; refusing VPN fallback");
    }
    Ok(selected)
}

fn observe_interfaces() -> anyhow::Result<Vec<ObservedInterface>> {
    let interfaces = NetworkInterface::show().context("failed to enumerate uplink interfaces")?;
    interfaces.into_iter().map(observe_interface).collect()
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn observe_interface(mut interface: NetworkInterface) -> anyhow::Result<ObservedInterface> {
    use std::path::Path;
    let root = Path::new("/sys/class/net");
    // getifaddrs follows the calling thread's network namespace. An inherited
    // sysfs mount may still expose the original namespace's devices.
    let link_up = nix::ifaddrs::getifaddrs().ok().and_then(|mut interfaces| {
        interfaces
            .find(|item| item.interface_name == interface.name)
            .map(|item| {
                use nix::net::if_::InterfaceFlags;
                item.flags.contains(InterfaceFlags::IFF_UP)
                    && item.flags.contains(InterfaceFlags::IFF_RUNNING)
            })
    });
    let up = link_up.unwrap_or(false) && !interface.internal;
    let automatic = linux_sysfs_matches_interface(root, &interface)
        && linux_has_hardware_uplink(root, &interface.name, &mut HashSet::new());
    let kind = linux_inventory_kind(root, &interface).to_owned();
    // setns is thread-local: /proc/self/net can refer to the process leader's
    // namespace when this inventory runs on a blocking worker.
    if let Ok(addresses) = std::fs::read_to_string("/proc/thread-self/net/if_inet6") {
        interface
            .addr
            .retain(|address| !linux_unusable_ipv6(&addresses, &interface.name, address.ip()));
    }
    Ok(ObservedInterface {
        interface,
        up,
        automatic,
        link_up,
        kind,
    })
}

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
fn linux_inventory_kind(root: &std::path::Path, interface: &NetworkInterface) -> &'static str {
    if interface.internal {
        return "loopback";
    }
    if !linux_sysfs_matches_interface(root, interface) {
        return "unknown";
    }
    let path = root.join(&interface.name);
    let device_type = std::fs::read_to_string(path.join("uevent")).unwrap_or_default();
    let has_type = |kind: &str| {
        device_type
            .lines()
            .any(|line| line == format!("DEVTYPE={kind}"))
    };
    if path.join("wireless").is_dir() || path.join("phy80211").exists() {
        "wifi"
    } else if path.join("bridge").is_dir() || path.join("brif").is_dir() {
        "bridge"
    } else if path.join("bonding").is_dir() {
        "bond"
    } else if has_type("vlan") {
        "vlan"
    } else if has_type("wireguard") {
        "wireguard"
    } else if let Ok(flags) = std::fs::read_to_string(path.join("tun_flags")) {
        if u32::from_str_radix(flags.trim().trim_start_matches("0x"), 16)
            .is_ok_and(|flags| flags & 2 != 0)
        {
            "tap"
        } else {
            "tun"
        }
    } else {
        match std::fs::read_to_string(path.join("type"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
        {
            Some(772) => "loopback",
            Some(512) => "ppp",
            Some(1) if path.join("device").exists() => "ethernet",
            // ARPHRD_NONE is shared by multiple tunnel drivers. Do not claim
            // WireGuard solely because an interface has that type or name.
            Some(1 | 65534) => "virtual",
            _ => "unknown",
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_sysfs_matches_interface(root: &std::path::Path, interface: &NetworkInterface) -> bool {
    let path = root.join(&interface.name);
    let index = std::fs::read_to_string(path.join("ifindex"))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok());
    let mac = std::fs::read_to_string(path.join("address")).ok();
    index == Some(interface.index)
        && interface
            .mac_addr
            .as_ref()
            .zip(mac.as_ref())
            .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual.trim()))
}

#[cfg(target_os = "linux")]
fn linux_has_hardware_uplink(
    root: &std::path::Path,
    name: &str,
    visiting: &mut HashSet<String>,
) -> bool {
    if visiting.len() >= 32 || !visiting.insert(name.to_owned()) {
        return false;
    }
    let result = (|| {
        let path = root.join(name);
        // TUN/TAP can present as Ethernet; a nonzero MAC is not proof.
        if path.join("tun_flags").exists() {
            return false;
        }
        let kind = std::fs::read_to_string(path.join("type"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        // Ethernet/Wi-Fi is ARPHRD_ETHER. Other media (including PPP) can be
        // selected explicitly, but must not accidentally admit PPP VPNs.
        if kind != Some(1) {
            return false;
        }
        if path.join("device").exists() {
            return true;
        }
        let vlan = std::fs::read_to_string(path.join("uevent"))
            .is_ok_and(|value| value.lines().any(|line| line == "DEVTYPE=vlan"));
        if !path.join("bridge").is_dir()
            && !path.join("brif").is_dir()
            && !path.join("bonding").is_dir()
            && !vlan
        {
            // A lower hardware link alone is insufficient: macvlan/container
            // adapters and Ethernet tunnels can also have a physical parent.
            return false;
        }
        // Hardware-free Ethernet includes veth, dummy, container bridges,
        // macvlan, VLAN, bridge and bond. Follow genuine kernel lower links;
        // a bridge consisting solely of veth/TAP will never reach hardware.
        let mut lowers = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                if let Some(lower) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.strip_prefix("lower_"))
                {
                    lowers.push(lower.to_owned());
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(path.join("brif")) {
            lowers.extend(
                entries
                    .flatten()
                    .filter_map(|entry| entry.file_name().into_string().ok()),
            );
        }
        lowers.sort();
        lowers.dedup();
        lowers
            .into_iter()
            .any(|lower| linux_has_hardware_uplink(root, &lower, visiting))
    })();
    visiting.remove(name);
    result
}

#[cfg(target_os = "linux")]
fn linux_unusable_ipv6(table: &str, name: &str, ip: IpAddr) -> bool {
    let IpAddr::V6(ip) = ip else {
        return false;
    };
    table.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() == 6
            && fields[5] == name
            && u128::from_str_radix(fields[0], 16).ok() == Some(u128::from(ip))
            && u32::from_str_radix(fields[4], 16)
                .is_ok_and(|flags| flags & (0x08 | 0x20 | 0x40) != 0)
    })
}

#[cfg(target_os = "windows")]
fn observe_interface(interface: NetworkInterface) -> anyhow::Result<ObservedInterface> {
    use windows::Win32::NetworkManagement::{
        IpHelper::{GetIfEntry2, MIB_IF_ROW2},
        Ndis::{IfOperStatusUp, TUNNEL_TYPE_NONE},
    };
    let mut row = MIB_IF_ROW2 {
        InterfaceIndex: interface.index,
        ..Default::default()
    };
    let status = unsafe { GetIfEntry2(&mut row) };
    if status.0 != 0 {
        // Missing metadata must not silently allow an unidentified VPN.
        return Ok(ObservedInterface {
            interface,
            up: false,
            automatic: false,
            link_up: None,
            kind: "unknown".to_owned(),
        });
    }
    let end = row
        .Description
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(row.Description.len());
    let description = String::from_utf16_lossy(&row.Description[..end]);
    let automatic = windows_automatic_uplink(
        row.Type,
        row.TunnelType == TUNNEL_TYPE_NONE,
        row.InterfaceAndOperStatusFlags._bitfield & 1 != 0,
        &description,
    );
    let kind = windows_inventory_kind(
        row.Type,
        row.TunnelType == TUNNEL_TYPE_NONE,
        row.InterfaceAndOperStatusFlags._bitfield & 1 != 0,
        &description,
    )
    .to_owned();
    Ok(ObservedInterface {
        interface,
        up: row.OperStatus == IfOperStatusUp,
        automatic,
        link_up: Some(row.OperStatus == IfOperStatusUp),
        kind,
    })
}

#[cfg(any(target_os = "windows", test))]
fn windows_inventory_kind(
    kind: u32,
    no_tunnel: bool,
    hardware: bool,
    description: &str,
) -> &'static str {
    let description = description.to_ascii_lowercase();
    if kind == 24 {
        "loopback"
    } else if description.contains("wireguard") {
        "wireguard"
    } else if description.contains("tap-windows") {
        "tap"
    } else if description.contains("wintun") {
        "tun"
    } else if kind == 23 {
        "ppp"
    } else if !no_tunnel {
        "virtual"
    } else if kind == 71 {
        "wifi"
    } else if matches!(kind, 243 | 244) {
        "cellular"
    } else if kind == 6 && windows_automatic_uplink(kind, no_tunnel, hardware, &description) {
        "ethernet"
    } else if kind == 6 {
        "virtual"
    } else {
        "unknown"
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_automatic_uplink(kind: u32, no_tunnel: bool, hardware: bool, description: &str) -> bool {
    let description = description.to_ascii_lowercase();
    let excluded = [
        "wireguard",
        "wintun",
        "tap-windows",
        "tailscale",
        "zerotier",
        "easytier",
        "openvpn",
        "vpn adapter",
        "virtualbox host-only",
        "vmware virtual ethernet adapter",
        "hyper-v virtual ethernet",
        "docker",
        "wsl",
    ];
    if !no_tunnel
        || !matches!(kind, 6 | 71 | 243 | 244)
        || excluded.iter().any(|part| description.contains(part))
    {
        return false;
    }
    hardware
        || [
            "vmxnet",
            "virtio",
            "hyper-v network adapter",
            "virtualbox ethernet",
            "parallels ethernet",
        ]
        .iter()
        .any(|part| description.contains(part))
}

#[cfg(any(
    target_os = "android",
    target_os = "ios",
    target_os = "macos",
    target_os = "freebsd",
    target_env = "ohos"
))]
fn observe_interface(interface: NetworkInterface) -> anyhow::Result<ObservedInterface> {
    // Mobile sockets are separately protected/bound to the platform network by
    // the host adapter. Interface-name classification is deliberately narrow
    // when the portable inventory cannot expose OS adapter types.
    let name = interface.name.to_ascii_lowercase();
    let automatic = portable_automatic_uplink(&name);
    Ok(ObservedInterface {
        up: !interface.internal,
        interface,
        automatic,
        link_up: None,
        kind: "unknown".to_owned(),
    })
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "windows",
    target_os = "android",
    target_os = "ios",
    target_os = "macos",
    target_os = "freebsd",
    target_env = "ohos"
)))]
fn observe_interface(interface: NetworkInterface) -> anyhow::Result<ObservedInterface> {
    Ok(ObservedInterface {
        interface,
        up: false,
        automatic: false,
        link_up: None,
        kind: "unknown".to_owned(),
    })
}

#[cfg(any(
    not(any(target_os = "linux", target_os = "windows")),
    target_env = "ohos",
    test
))]
fn portable_automatic_uplink(name: &str) -> bool {
    [
        "en", "eth", "wlan", "rmnet", "ccmni", "pdp_ip", "re", "igb", "ix", "vtnet", "vmx",
    ]
    .iter()
    .any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|suffix| {
            suffix
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit() || ch == '_')
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn observed(name: &str, index: u32, automatic: bool, up: bool, ip: &str) -> ObservedInterface {
        ObservedInterface {
            interface: NetworkInterface::new_afinet(
                name,
                ip.parse().unwrap(),
                Some(Ipv4Addr::new(255, 255, 255, 0)),
                None,
                index,
                false,
            ),
            up,
            automatic,
            link_up: Some(up),
            kind: if automatic { "ethernet" } else { "virtual" }.to_owned(),
        }
    }
    fn manual(names: &[&str]) -> UplinkConfig {
        UplinkConfig {
            mode: UplinkMode::Manual,
            interfaces: names.iter().map(|name| (*name).to_owned()).collect(),
        }
    }

    #[test]
    fn inventory_is_complete_independently_of_current_manual_allowlist() {
        let raw = vec![
            observed("ens18", 2, true, true, "10.0.2.1"),
            observed("ens19", 4, true, true, "192.168.0.1"),
            observed("wg0", 7, false, true, "10.200.0.1"),
        ];
        let selected = select_interfaces(&manual(&["ens18"]), raw.clone()).unwrap();
        assert_eq!(selected.len(), 1);
        let inventory: Vec<_> = raw
            .into_iter()
            .map(|item| {
                let addresses = item.interface.addr.clone();
                inventory_interface(item, addresses)
            })
            .collect();
        assert_eq!(
            inventory
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["ens18", "ens19", "wg0"]
        );
        assert!(inventory.iter().all(|item| item.manual_selectable));
        assert!(inventory[0].auto_eligible);
        assert!(inventory[1].auto_eligible);
        assert!(!inventory[2].auto_eligible);
    }

    #[test]
    fn inventory_retains_down_addressless_and_loopback_interfaces() {
        let down = observed("ens19", 4, true, false, "192.168.0.1");
        let inventory = inventory_interface(down.clone(), down.interface.addr);
        assert_eq!(inventory.up, Some(false));
        assert!(inventory.manual_selectable);
        assert!(!inventory.auto_eligible);

        let mut addressless = observed("ens20", 5, true, true, "192.168.1.1");
        addressless.interface.addr.clear();
        let inventory = inventory_interface(addressless, Vec::new());
        assert!(inventory.addresses.is_empty());
        assert!(inventory.manual_selectable);
        assert!(!inventory.auto_eligible);

        let mut loopback = observed("lo", 1, false, true, "127.0.0.1");
        loopback.interface.internal = true;
        loopback.kind = "loopback".to_owned();
        let inventory = inventory_interface(loopback.clone(), loopback.interface.addr);
        assert_eq!(inventory.up, Some(true));
        assert_eq!(inventory.kind, "loopback");
        assert!(!inventory.manual_selectable);
        assert!(!inventory.auto_eligible);

        let zero_index = observed("unknown", 0, true, true, "10.0.2.1");
        let inventory = inventory_interface(zero_index.clone(), zero_index.interface.addr);
        assert!(!inventory.manual_selectable);
        assert!(!inventory.auto_eligible);
    }

    #[test]
    fn inventory_keeps_raw_addresses_and_unknown_link_state() {
        let mut observed = observed("ens18", 2, true, false, "10.0.2.1");
        let addresses = observed.interface.addr.clone();
        // Candidate filtering may remove addresses, but cannot remove them
        // from management observations or invent a known Down link state.
        observed.interface.addr.clear();
        observed.link_up = None;
        let inventory = inventory_interface(observed, addresses);
        assert_eq!(inventory.addresses.len(), 1);
        assert_eq!(
            inventory.addresses[0].address,
            "10.0.2.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(inventory.addresses[0].prefix_length, Some(24));
        assert_eq!(inventory.up, None);
        assert!(!inventory.auto_eligible);
    }

    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[tokio::test]
    async fn inventory_namespace_errors_do_not_poison_subsequent_observations() {
        let before = std::fs::read_link("/proc/thread-self/ns/net").unwrap();
        let missing = format!("easytier-inventory-nonexistent-{}", std::process::id());
        let error = network_interface_inventory(Some(missing))
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("failed to open network namespace")
        );
        let error = network_interface_inventory(Some("../unsafe".to_owned()))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("invalid network namespace"));
        let inventory = network_interface_inventory(None).await.unwrap();
        assert!(inventory.supported);
        assert!(inventory.sampled_at_unix_ms > 0);
        assert!(inventory.namespace.is_none());
        assert_eq!(
            std::fs::read_link("/proc/thread-self/ns/net").unwrap(),
            before
        );
    }

    #[test]
    fn inventory_windows_reports_real_adapter_metadata_types() {
        assert_eq!(
            windows_inventory_kind(24, true, false, "Loopback"),
            "loopback"
        );
        assert_eq!(
            windows_inventory_kind(6, true, true, "Intel Ethernet"),
            "ethernet"
        );
        assert_eq!(windows_inventory_kind(71, true, true, "Wi-Fi"), "wifi");
        assert_eq!(windows_inventory_kind(243, true, true, "WWAN"), "cellular");
        assert_eq!(windows_inventory_kind(244, true, true, "WWAN2"), "cellular");
        assert_eq!(
            windows_inventory_kind(6, true, false, "WireGuard Tunnel"),
            "wireguard"
        );
        assert_eq!(
            windows_inventory_kind(6, true, false, "TAP-Windows Adapter"),
            "tap"
        );
        assert_eq!(
            windows_inventory_kind(53, true, false, "Wintun Adapter"),
            "tun"
        );
        assert_eq!(
            windows_inventory_kind(23, true, false, "PPP Adapter"),
            "ppp"
        );
        assert_eq!(
            windows_inventory_kind(131, false, false, "ISATAP"),
            "virtual"
        );
    }

    #[test]
    fn automatic_excludes_vpn_and_preserves_multiple_uplinks() {
        let selected = select_interfaces(
            &UplinkConfig::default(),
            vec![
                observed("wg0", 3, false, true, "10.200.0.1"),
                observed("ens18", 2, true, true, "10.0.2.1"),
                observed("ens19", 4, true, true, "192.168.0.1"),
            ],
        )
        .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|interface| interface.name.as_str())
                .collect::<Vec<_>>(),
            ["ens18", "ens19"]
        );
    }
    #[test]
    fn manual_requires_every_exact_interface_and_never_falls_back() {
        let inventory = vec![observed("ens18", 2, true, true, "10.0.2.1")];
        assert!(select_interfaces(&manual(&["ens19"]), inventory.clone()).is_err());
        assert!(select_interfaces(&manual(&["ens18", "ens19"]), inventory.clone()).is_err());
        assert!(select_interfaces(&manual(&["ENS18"]), inventory.clone()).is_err());
        assert!(select_interfaces(&manual(&[]), inventory).is_err());
    }
    #[test]
    fn manual_allows_explicit_logical_wan_and_keeps_order() {
        let selected = select_interfaces(
            &manual(&["ppp0", "ens18"]),
            vec![
                observed("ens18", 2, true, true, "10.0.2.1"),
                observed("ppp0", 9, false, true, "198.51.100.2"),
            ],
        )
        .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|interface| interface.name.as_str())
                .collect::<Vec<_>>(),
            ["ppp0", "ens18"]
        );
    }
    #[test]
    fn unavailable_or_down_selection_fails_closed() {
        assert!(
            select_interfaces(
                &manual(&["ens18"]),
                vec![observed("ens18", 2, true, false, "10.0.2.1")]
            )
            .is_err()
        );
        assert!(
            select_interfaces(
                &UplinkConfig::default(),
                vec![observed("wg0", 3, false, true, "10.200.0.1")]
            )
            .is_err()
        );
        assert!(select_interfaces(&manual(&["ens18", "ens18"]), Vec::new()).is_err());
    }
    #[test]
    fn manual_failover_stays_inside_the_allowlist_when_one_known_link_is_down() {
        let selected = select_interfaces(
            &manual(&["ens18", "ens19"]),
            vec![
                observed("ens18", 2, true, false, "10.0.2.1"),
                observed("ens19", 4, true, true, "192.168.0.1"),
                observed("wg0", 7, false, true, "10.200.0.1"),
            ],
        )
        .unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|interface| interface.name.as_str())
                .collect::<Vec<_>>(),
            ["ens19"]
        );
        assert!(
            select_interfaces(
                &manual(&["ens18", "ens19"]),
                vec![
                    observed("ens18", 2, true, false, "10.0.2.1"),
                    observed("wg0", 7, false, true, "10.200.0.1")
                ],
            )
            .is_err()
        );
    }
    #[test]
    fn lan_addresses_remain_usable_but_unscoped_link_local_does_not() {
        for ip in ["10.0.2.1", "192.168.1.1", "fd00:1::1", "2001:db8::1"] {
            assert!(usable_unicast_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "0.0.0.0",
            "127.0.0.1",
            "169.254.1.1",
            "255.255.255.255",
            "::",
            "::1",
            "fe80::1",
            "ff02::1",
            "::ffff:192.0.2.1",
        ] {
            assert!(!usable_unicast_address(ip.parse().unwrap()), "{ip}");
        }
    }
    #[test]
    fn windows_uses_adapter_type_and_preserves_guest_hardware() {
        assert!(windows_automatic_uplink(6, true, true, "Intel Ethernet"));
        assert!(windows_automatic_uplink(71, true, true, "Wi-Fi"));
        assert!(windows_automatic_uplink(
            6,
            true,
            false,
            "VMware vmxnet3 Ethernet Adapter"
        ));
        assert!(windows_automatic_uplink(
            6,
            true,
            false,
            "Red Hat VirtIO Ethernet Adapter"
        ));
        assert!(!windows_automatic_uplink(
            6,
            true,
            false,
            "VMware Virtual Ethernet Adapter for VMnet8"
        ));
        assert!(!windows_automatic_uplink(
            6,
            true,
            true,
            "TAP-Windows Adapter V9"
        ));
        assert!(!windows_automatic_uplink(131, false, false, "ISATAP"));
    }
    #[test]
    fn portable_names_do_not_accept_arbitrary_virtual_interfaces() {
        for name in ["en0", "wlan0", "rmnet_data0", "vtnet0", "vmx0"] {
            assert!(portable_automatic_uplink(name), "{name}");
        }
        for name in [
            "wg0",
            "tun0",
            "utun4",
            "veth12",
            "docker0",
            "easytier0",
            "endpoint0",
        ] {
            assert!(!portable_automatic_uplink(name), "{name}");
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_rejects_sysfs_metadata_from_a_different_namespace() {
        use std::fs;
        let root = tempfile::tempdir().unwrap();
        let interface = observed("eth0", 2, false, true, "10.0.2.1")
            .interface
            .with_mac_addr(Some("02:00:00:00:00:01".to_owned()));
        let path = root.path().join("eth0");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("ifindex"), "2\n").unwrap();
        fs::write(path.join("address"), "02:00:00:00:00:02\n").unwrap();
        assert!(!linux_sysfs_matches_interface(root.path(), &interface));
        fs::write(path.join("address"), "02:00:00:00:00:01\n").unwrap();
        assert!(linux_sysfs_matches_interface(root.path(), &interface));
        fs::write(path.join("ifindex"), "3\n").unwrap();
        assert!(!linux_sysfs_matches_interface(root.path(), &interface));
        assert!(!linux_sysfs_matches_interface(
            root.path(),
            &observed("missing0", 2, false, true, "10.0.2.1").interface
        ));
    }
    #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
    #[test]
    fn inventory_linux_types_require_matching_metadata_and_do_not_guess_vpn_names() {
        use std::fs;
        let root = tempfile::tempdir().unwrap();
        let add = |name: &str, kind: &str| {
            let path = root.path().join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("ifindex"), "2\n").unwrap();
            fs::write(path.join("address"), "02:00:00:00:00:01\n").unwrap();
            fs::write(path.join("type"), kind).unwrap();
            path
        };
        let interface = |name: &str| {
            observed(name, 2, false, true, "10.0.2.1")
                .interface
                .with_mac_addr(Some("02:00:00:00:00:01".to_owned()))
        };
        let ethernet = add("ens18", "1");
        fs::create_dir(ethernet.join("device")).unwrap();
        let wifi = add("radio0", "1");
        fs::create_dir(wifi.join("wireless")).unwrap();
        let bridge = add("bridge0", "1");
        fs::create_dir(bridge.join("bridge")).unwrap();
        let bond = add("bond0", "1");
        fs::create_dir(bond.join("bonding")).unwrap();
        let vlan = add("wan35", "1");
        fs::write(vlan.join("uevent"), "DEVTYPE=vlan\n").unwrap();
        let tun = add("not-a-tun-name", "65534");
        fs::write(tun.join("tun_flags"), "0x1001\n").unwrap();
        let tap = add("not-a-tap-name", "1");
        fs::write(tap.join("tun_flags"), "0x1002\n").unwrap();
        add("ppp0", "512");
        add("wg0", "65534");
        for (name, expected) in [
            ("ens18", "ethernet"),
            ("radio0", "wifi"),
            ("bridge0", "bridge"),
            ("bond0", "bond"),
            ("wan35", "vlan"),
            ("not-a-tun-name", "tun"),
            ("not-a-tap-name", "tap"),
            ("ppp0", "ppp"),
            ("wg0", "virtual"),
        ] {
            assert_eq!(
                linux_inventory_kind(root.path(), &interface(name)),
                expected,
                "{name}"
            );
        }
        fs::write(ethernet.join("ifindex"), "3\n").unwrap();
        assert_eq!(
            linux_inventory_kind(root.path(), &interface("ens18")),
            "unknown"
        );
        fs::write(ethernet.join("ifindex"), "2\n").unwrap();
        fs::write(ethernet.join("address"), "02:00:00:00:00:02\n").unwrap();
        assert_eq!(
            linux_inventory_kind(root.path(), &interface("ens18")),
            "unknown"
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_follows_hardware_stacks_and_rejects_container_and_tunnel_stacks() {
        use std::fs;
        let root = tempfile::tempdir().unwrap();
        let add = |name: &str, kind: &str| {
            let path = root.path().join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("type"), kind).unwrap();
            path
        };
        let physical = add("ens18", "1");
        fs::create_dir(physical.join("device")).unwrap();
        let vm_nic = add("ens19", "1");
        fs::create_dir(vm_nic.join("device")).unwrap();
        let vlan = add("wan.35", "1");
        fs::write(vlan.join("uevent"), "DEVTYPE=vlan\n").unwrap();
        fs::create_dir(vlan.join("lower_ens18")).unwrap();
        let bond = add("bond0", "1");
        fs::create_dir(bond.join("bonding")).unwrap();
        fs::create_dir(bond.join("lower_ens19")).unwrap();
        let bridge = add("br-lan", "1");
        fs::create_dir_all(bridge.join("brif/wan.35")).unwrap();
        let veth = add("veth0", "1");
        let _ = veth;
        let container_bridge = add("docker0", "1");
        fs::create_dir_all(container_bridge.join("brif/veth0")).unwrap();
        let container_macvlan = add("macvlan0", "1");
        fs::create_dir(container_macvlan.join("lower_ens18")).unwrap();
        add("wg0", "65534");
        let tap = add("tap0", "1");
        fs::write(tap.join("tun_flags"), "0x1002").unwrap();
        add("ppp0", "512");
        for name in ["ens18", "ens19", "wan.35", "bond0", "br-lan"] {
            assert!(
                linux_has_hardware_uplink(root.path(), name, &mut HashSet::new()),
                "{name}"
            );
        }
        for name in [
            "veth0", "docker0", "macvlan0", "wg0", "tap0", "ppp0", "missing",
        ] {
            assert!(
                !linux_has_hardware_uplink(root.path(), name, &mut HashSet::new()),
                "{name}"
            );
        }
        fs::create_dir_all(root.path().join("cycle0")).unwrap();
        fs::write(root.path().join("cycle0/type"), "1").unwrap();
        fs::create_dir(root.path().join("cycle0/lower_cycle0")).unwrap();
        assert!(!linux_has_hardware_uplink(
            root.path(),
            "cycle0",
            &mut HashSet::new()
        ));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_ignores_tentative_failed_and_deprecated_ipv6_addresses() {
        let table = "20010db8000000000000000000000001 02 40 00 40 ens18\n20010db8000000000000000000000002 02 40 00 08 ens18\n20010db8000000000000000000000003 02 40 00 20 ens18\n20010db8000000000000000000000004 02 40 00 00 ens18";
        for ip in ["2001:db8::1", "2001:db8::2", "2001:db8::3"] {
            assert!(linux_unusable_ipv6(table, "ens18", ip.parse().unwrap()));
        }
        assert!(!linux_unusable_ipv6(
            table,
            "ens18",
            "2001:db8::4".parse().unwrap()
        ));
        assert!(!linux_unusable_ipv6(
            table,
            "ens19",
            "2001:db8::1".parse().unwrap()
        ));
    }
}
