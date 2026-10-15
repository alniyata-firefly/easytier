use std::{
    collections::HashMap,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
#[cfg(any(feature = "wireguard", test))]
use easytier_core::socket::{
    NetNamespace,
    udp::{UdpSessionAcceptKind, UdpSessionListenRequest, UdpSessionSocketListener},
};
use easytier_core::socket::{
    SocketContext,
    udp::{
        MAX_UDP_DATAGRAM_SIZE, MAX_UDP_SESSION_DATAGRAM_SIZE, UdpBindOptions, UdpSocketDatagram,
        UdpSocketPurpose, UdpSocketRecvMeta, UdpSocketSendMeta, VirtualUdpSocket,
        VirtualUdpSocketFactory,
    },
};
use tokio::net::UdpSocket;

#[cfg(any(feature = "wireguard", test))]
use crate::host_runtime::{NativeHostRuntime, native_host_runtime};
use crate::{
    common::netns::NetNS,
    tunnel::common::{BindDev, bind},
};

use super::udp_src;
use super::uplink::{
    UplinkPortProtocol, UplinkSource, lease_uplink_port, normalized_ip, source_for_remote,
    validate_local_bind,
};

#[cfg(any(feature = "wireguard", test))]
pub(crate) type RuntimeUdpSessionSocketListener = UdpSessionSocketListener<NativeHostRuntime>;

#[cfg(any(feature = "wireguard", test))]
pub(crate) fn new_runtime_udp_session_listener(
    url: url::Url,
    mut request: UdpSessionListenRequest,
    accept_kind: UdpSessionAcceptKind,
    net_ns: NetNS,
) -> RuntimeUdpSessionSocketListener {
    request.bind.context.netns = net_ns.name().map(NetNamespace::new);
    let runtime = native_host_runtime();
    UdpSessionSocketListener::new_with_request(url, request, accept_kind, runtime)
}

pub struct RuntimeUdpSocket {
    socket: Arc<UdpSocket>,
    context: SocketContext,
    bound_interface: Option<String>,
    uplink_sockets: RwLock<Vec<(u32, Arc<UdpSocket>)>>,
    uplink_bind: Option<UdpBindOptions>,
    uplink_socket_creation: tokio::sync::Mutex<()>,
    receive_waker: futures::task::AtomicWaker,
    receive_cursor: AtomicUsize,
    _port_lease: Option<Arc<()>>,
    routes: Mutex<HashMap<(SocketAddr, Option<IpAddr>, Option<u32>), (Instant, UplinkSource)>>,
    allowed_addresses: Mutex<Option<(Instant, Vec<IpAddr>)>>,
}

impl RuntimeUdpSocket {
    #[cfg(test)]
    fn new(socket: Arc<UdpSocket>) -> Self {
        Self::new_with_context(socket, SocketContext::default())
    }

    fn new_with_context(socket: Arc<UdpSocket>, context: SocketContext) -> Self {
        if let Err(err) = udp_src::enable_recv_pktinfo(&socket) {
            tracing::debug!(?err, "enable udp pktinfo failed");
        }
        Self {
            socket,
            context,
            bound_interface: None,
            uplink_sockets: RwLock::new(Vec::new()),
            uplink_bind: None,
            uplink_socket_creation: tokio::sync::Mutex::new(()),
            receive_waker: futures::task::AtomicWaker::new(),
            receive_cursor: AtomicUsize::new(0),
            _port_lease: None,
            routes: Mutex::new(HashMap::new()),
            allowed_addresses: Mutex::new(None),
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn socket(&self) -> Arc<UdpSocket> {
        self.socket.clone()
    }

    async fn receive_with_meta(
        &self,
        buf: &mut [u8],
    ) -> io::Result<(usize, SocketAddr, Option<IpAddr>)> {
        if self.uplink_bind.is_none() {
            return udp_src::recv_from_with_dst_ip(&self.socket, buf).await;
        }
        // Poll each OS socket with one caller buffer. Async readiness futures
        // remove their waiter when canceled, so a pending read must register
        // the socket's persistent poll waker before the temporary is dropped.
        futures::future::poll_fn(|cx| {
            self.receive_waker.register(cx.waker());
            let sockets = self.uplink_sockets.read().unwrap();
            let count = sockets.len() + 1;
            let start = self.receive_cursor.fetch_add(1, Ordering::Relaxed) % count;
            for offset in 0..count {
                let index = (start + offset) % count;
                let socket = if index == 0 {
                    self.socket.as_ref()
                } else {
                    sockets[index - 1].1.as_ref()
                };
                let receive = udp_src::recv_from_with_dst_ip(socket, buf);
                tokio::pin!(receive);
                if let std::task::Poll::Ready(result) =
                    std::future::Future::poll(receive.as_mut(), cx)
                {
                    return std::task::Poll::Ready(result);
                }
                if let Err(error) = Self::rearm_receive(socket, cx) {
                    return std::task::Poll::Ready(Err(error));
                }
            }
            std::task::Poll::Pending
        })
        .await
    }

    #[cfg(unix)]
    async fn receive_owned(
        &self,
        capacity: usize,
    ) -> io::Result<(bytes::BytesMut, SocketAddr, Option<IpAddr>)> {
        if self.uplink_bind.is_none() {
            return udp_src::recv_datagram_with_dst_ip(&self.socket, capacity).await;
        }
        let mut payload = bytes::BytesMut::with_capacity(capacity);
        let (remote_addr, dst_ip) = futures::future::poll_fn(|cx| {
            self.receive_waker.register(cx.waker());
            let sockets = self.uplink_sockets.read().unwrap();
            let count = sockets.len() + 1;
            let start = self.receive_cursor.fetch_add(1, Ordering::Relaxed) % count;
            for offset in 0..count {
                let index = (start + offset) % count;
                let socket = if index == 0 {
                    self.socket.as_ref()
                } else {
                    sockets[index - 1].1.as_ref()
                };
                let receive = udp_src::recv_datagram_into_with_dst_ip(socket, &mut payload);
                tokio::pin!(receive);
                if let std::task::Poll::Ready(result) =
                    std::future::Future::poll(receive.as_mut(), cx)
                {
                    return std::task::Poll::Ready(result);
                }
                if let Err(error) = Self::rearm_receive(socket, cx) {
                    return std::task::Poll::Ready(Err(error));
                }
            }
            std::task::Poll::Pending
        })
        .await?;
        Ok((payload, remote_addr, dst_ip))
    }

    fn rearm_receive(socket: &UdpSocket, cx: &mut std::task::Context<'_>) -> io::Result<()> {
        match socket.poll_recv_ready(cx) {
            std::task::Poll::Ready(Ok(())) => {
                // A datagram may have arrived between the attempted read and
                // registration. Poll again rather than losing that edge.
                cx.waker().wake_by_ref();
                Ok(())
            }
            std::task::Poll::Ready(Err(error)) => Err(error),
            std::task::Poll::Pending => Ok(()),
        }
    }

    async fn socket_for_source(&self, source: &UplinkSource) -> io::Result<Arc<UdpSocket>> {
        let Some(bind_options) = &self.uplink_bind else {
            return Ok(self.socket.clone());
        };
        if let Some((_, socket)) = self
            .uplink_sockets
            .read()
            .unwrap()
            .iter()
            .find(|(index, _)| *index == source.ifindex)
        {
            return Ok(socket.clone());
        }
        let _creation = self.uplink_socket_creation.lock().await;
        if let Some((_, socket)) = self
            .uplink_sockets
            .read()
            .unwrap()
            .iter()
            .find(|(index, _)| *index == source.ifindex)
        {
            return Ok(socket.clone());
        }
        let interfaces = crate::common::uplink::selected_interfaces(&self.context)
            .await
            .map_err(io::Error::other)?;
        if !interfaces.iter().any(|interface| {
            interface.index == source.ifindex && interface.name == source.interface
        }) {
            return Err(io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                "selected UDP uplink is no longer available",
            ));
        }
        let bound = create_udp_socket(
            &bind_options
                .clone()
                .with_bind_device(Some(source.interface.clone())),
        )
        .await
        .map_err(io::Error::other)?;
        udp_src::enable_recv_pktinfo(&bound)?;
        let socket = Arc::new(bound);
        {
            let mut sockets = self.uplink_sockets.write().unwrap();
            sockets
                .retain(|(index, _)| interfaces.iter().any(|interface| interface.index == *index));
            sockets.push((source.ifindex, socket.clone()));
        }
        *self.allowed_addresses.lock().unwrap() = None;
        // One receive owner, matching Tokio UDP readiness. Wake it so replies
        // assigned to a newly created child cannot strand an earlier wait.
        self.receive_waker.wake();
        Ok(socket)
    }

    async fn selected_source(
        &self,
        addr: SocketAddr,
        meta: UdpSocketSendMeta,
    ) -> io::Result<UplinkSource> {
        let bound_ip = self.socket.local_addr()?.ip();
        let requested_ip = meta
            .src_ip
            .or((!bound_ip.is_unspecified()).then_some(bound_ip));
        let key = (addr, requested_ip, meta.src_ifindex);
        if let Some((created, source)) = self.routes.lock().unwrap().get(&key) {
            if created.elapsed() < Duration::from_secs(5) {
                return Ok(source.clone());
            }
        }
        let source = source_for_remote(
            &self.context,
            addr,
            requested_ip,
            self.bound_interface.as_deref(),
            true,
        )
        .await?;
        if meta
            .src_ifindex
            .is_some_and(|index| index != source.ifindex)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "UDP requested source interface does not match an allowed uplink",
            ));
        }
        {
            let mut allowed = self.allowed_addresses.lock().unwrap();
            if allowed.as_ref().is_some_and(|(_, addresses)| {
                !addresses.contains(&normalized_ip(source.address.ip()))
            }) {
                *allowed = None;
            }
        }
        let mut routes = self.routes.lock().unwrap();
        if routes.len() >= 256 {
            routes.clear();
        }
        routes.insert(key, (Instant::now(), source.clone()));
        Ok(source)
    }

    async fn destination_allowed(&self, dst: Option<IpAddr>) -> io::Result<bool> {
        if self.context.uplink.is_none() {
            return Ok(true);
        }
        let Some(dst) = dst else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "uplink-restricted UDP listener requires destination packet info",
            ));
        };
        let dst = normalized_ip(dst);
        if dst.is_loopback() {
            return Ok(true);
        }
        {
            let allowed = self.allowed_addresses.lock().unwrap();
            if let Some((created, addresses)) = allowed.as_ref() {
                if created.elapsed() < Duration::from_secs(5) {
                    return Ok(addresses.contains(&dst));
                }
            }
        }
        let addresses: Vec<_> = crate::common::uplink::selected_interfaces(&self.context)
            .await
            .map_err(io::Error::other)?
            .into_iter()
            .flat_map(|interface| interface.addresses.into_iter().map(|addr| addr.ip()))
            .collect();
        let result = addresses.contains(&dst);
        *self.allowed_addresses.lock().unwrap() = Some((Instant::now(), addresses));
        Ok(result)
    }
}

#[async_trait]
impl VirtualUdpSocket for RuntimeUdpSocket {
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.socket.local_addr()
    }

    fn socket_context(&self) -> SocketContext {
        self.context.clone()
    }

    async fn send_to(&self, data: &[u8], addr: SocketAddr) -> std::io::Result<usize> {
        self.send_to_with_meta(data, addr, UdpSocketSendMeta::default())
            .await
    }

    async fn recv_from(&self, buf: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> {
        let (len, addr, _) = self.recv_from_with_meta(buf).await?;
        Ok((len, addr))
    }

    async fn send_to_with_meta(
        &self,
        data: &[u8],
        addr: SocketAddr,
        meta: UdpSocketSendMeta,
    ) -> std::io::Result<usize> {
        if self.context.uplink.is_some() && !normalized_ip(addr.ip()).is_loopback() {
            let source = self.selected_source(addr, meta).await?;
            let send_socket = match self.socket_for_source(&source).await {
                Ok(socket) => socket,
                Err(error) => {
                    self.routes.lock().unwrap().clear();
                    return Err(error);
                }
            };
            let result = udp_src::send_to_with_src_interface(
                &send_socket,
                normalized_ip(source.address.ip()),
                source.ifindex,
                addr,
                data,
            )
            .await;
            if result.is_err() {
                self.routes.lock().unwrap().clear();
            }
            return result;
        }
        if let (Some(IpAddr::V6(src)), Some(ifindex), SocketAddr::V6(dst)) =
            (meta.src_ip, meta.src_ifindex, addr)
        {
            return udp_src::send_to_with_src_ipv6(&self.socket, src, ifindex, dst, data);
        }
        if let Some(src_ip) = meta.src_ip {
            return udp_src::send_to_with_src_ip(&self.socket, src_ip, addr, data).await;
        }
        self.socket.send_to(data, addr).await
    }

    async fn recv_from_with_meta(
        &self,
        buf: &mut [u8],
    ) -> std::io::Result<(usize, SocketAddr, UdpSocketRecvMeta)> {
        loop {
            let (len, addr, dst_ip) = self.receive_with_meta(buf).await?;
            if self.destination_allowed(dst_ip).await? {
                return Ok((len, addr, UdpSocketRecvMeta { dst_ip }));
            }
        }
    }

    #[cfg(unix)]
    async fn recv_datagram(&self) -> std::io::Result<UdpSocketDatagram> {
        loop {
            let (payload, remote_addr, dst_ip) = self.receive_owned(MAX_UDP_DATAGRAM_SIZE).await?;
            if self.destination_allowed(dst_ip).await? {
                return Ok(UdpSocketDatagram {
                    payload,
                    remote_addr,
                    meta: UdpSocketRecvMeta { dst_ip },
                });
            }
        }
    }

    #[cfg(unix)]
    async fn recv_session_datagram(&self) -> std::io::Result<UdpSocketDatagram> {
        loop {
            let (payload, remote_addr, dst_ip) =
                self.receive_owned(MAX_UDP_SESSION_DATAGRAM_SIZE).await?;
            if self.destination_allowed(dst_ip).await? {
                return Ok(UdpSocketDatagram {
                    payload,
                    remote_addr,
                    meta: UdpSocketRecvMeta { dst_ip },
                });
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct RuntimeUdpSocketFactory;

impl RuntimeUdpSocketFactory {
    pub(crate) fn new() -> Self {
        Self
    }

    fn bind_device_for(&self, options: &UdpBindOptions) -> BindDev {
        if let Some(bind_device) = &options.bind_device {
            return BindDev::from(bind_device.as_str());
        }

        if matches!(
            options.purpose,
            UdpSocketPurpose::DirectConnect
                | UdpSocketPurpose::PortBoundListener
                | UdpSocketPurpose::PortForward
        ) {
            return BindDev::Auto;
        }

        BindDev::Disabled
    }

    fn reuse_addr_for(&self, options: &UdpBindOptions) -> bool {
        options.reuse_addr
            || (matches!(
                options.purpose,
                UdpSocketPurpose::PortBoundListener
                    | UdpSocketPurpose::ProxyNat
                    | UdpSocketPurpose::PortForward
            ) && !cfg!(target_os = "windows"))
    }
}

/// Creates a host-owned UDP socket, including any required protection, before
/// it can be used by DNS, a route probe, or a virtual socket adapter.
pub(crate) async fn create_udp_socket(options: &UdpBindOptions) -> anyhow::Result<UdpSocket> {
    let factory = RuntimeUdpSocketFactory::new();
    let bind_addr = options
        .local_addr
        .unwrap_or_else(|| SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)));
    let bind_device = if uses_uplink_policy(options) {
        validate_local_bind(
            &options.context,
            options.local_addr,
            options.bind_device.as_deref(),
        )
        .await?
        .unwrap_or_else(|| factory.bind_device_for(options))
    } else {
        factory.bind_device_for(options)
    };
    Ok(bind::<UdpSocket>()
        .addr(bind_addr)
        .dev(bind_device)
        .net_ns(NetNS::from_socket_context(&options.context))
        .only_v6(options.only_v6)
        .reuse_addr(factory.reuse_addr_for(options))
        .reuse_port(options.reuse_port)
        .maybe_socket_mark(options.context.socket_mark)
        .need_protect(options.need_protect)
        .call()
        .await?)
}

fn uses_uplink_policy(options: &UdpBindOptions) -> bool {
    options.context.uplink.is_some()
        && matches!(
            options.purpose,
            UdpSocketPurpose::DirectConnect
                | UdpSocketPurpose::PortBoundListener
                | UdpSocketPurpose::HolePunchCandidate
                | UdpSocketPurpose::StunProbe
                | UdpSocketPurpose::HolePunchControl
        )
        && !options
            .local_addr
            .is_some_and(|addr| addr.ip().is_loopback())
}

#[async_trait]
impl VirtualUdpSocketFactory for RuntimeUdpSocketFactory {
    type Socket = RuntimeUdpSocket;

    async fn bind_udp(&self, mut options: UdpBindOptions) -> anyhow::Result<Arc<Self::Socket>> {
        if !uses_uplink_policy(&options) {
            options.context.uplink = None;
        }
        #[cfg(target_os = "android")]
        if options.context.uplink.is_some() {
            anyhow::bail!(
                "strict uplink policy requires an Android underlying-Network socket binder"
            );
        }
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        let per_interface_sockets = options.context.uplink.is_some()
            && options
                .local_addr
                .is_none_or(|address| address.ip().is_unspecified())
            && options.bind_device.as_deref().is_none_or(str::is_empty);
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
        let per_interface_sockets = false;
        if per_interface_sockets {
            options.reuse_addr = true;
            options.reuse_port = true;
        }
        let automatic_wildcard =
            options.context.uplink.as_ref().is_some_and(|policy| {
                policy.mode == easytier_core::config::uplink::UplinkMode::Auto
            }) && options
                .local_addr
                .is_none_or(|address| address.ip().is_unspecified())
                && options.bind_device.as_deref().is_none_or(str::is_empty);
        let (socket, awaiting_uplink) = match create_udp_socket(&options).await {
            Ok(socket) => (socket, false),
            Err(error) if automatic_wildcard => {
                // validate_local_bind reports through io::Error, so confirm
                // the typed inventory condition directly rather than matching
                // a formatted error or swallowing a socket/protection error.
                let unavailable = crate::common::uplink::selected_interfaces(&options.context)
                    .await
                    .err()
                    .is_some_and(|error| error.is::<crate::common::uplink::NoAvailableUplink>());
                if !unavailable {
                    return Err(error);
                }
                // The destination is unknown at bind time. Keep loopback usable
                // while every physical uplink is down, without giving remote
                // traffic an unrestricted fallback socket. The returned socket
                // retains its policy: non-loopback sends and receives still
                // require an allowed uplink, and a later uplink can join its pool.
                let mut loopback_bind = options.clone();
                loopback_bind.context.uplink = None;
                loopback_bind.bind_device = Some(String::new());
                (create_udp_socket(&loopback_bind).await?, true)
            }
            Err(error) => return Err(error),
        };
        let port_lease = if options.context.uplink.is_some() {
            Some(lease_uplink_port(
                &options.context,
                socket.local_addr()?,
                options.only_v6,
                UplinkPortProtocol::Udp,
            )?)
        } else {
            None
        };
        let mut uplink_sockets = Vec::new();
        if per_interface_sockets && !awaiting_uplink {
            let local = socket.local_addr()?;
            let interfaces = crate::common::uplink::selected_interfaces(&options.context).await?;
            let mut last_error = None;
            for interface in interfaces {
                let bound_options = options
                    .clone()
                    .with_local_addr(Some(local))
                    .with_bind_device(Some(interface.name.clone()));
                match create_udp_socket(&bound_options).await {
                    Ok(bound) => {
                        if let Err(error) = udp_src::enable_recv_pktinfo(&bound) {
                            tracing::debug!(%error, "enable UDP uplink socket pktinfo failed");
                        }
                        uplink_sockets.push((interface.index, Arc::new(bound)));
                    }
                    Err(error) => {
                        tracing::debug!(interface = %interface.name, %error, "UDP uplink socket bind failed");
                        last_error = Some(error);
                    }
                }
            }
            if uplink_sockets.is_empty() {
                return Err(last_error
                    .unwrap_or_else(|| anyhow::anyhow!("no UDP uplink socket could be bound")));
            }
        }
        let uplink_bind = if per_interface_sockets {
            Some(options.clone().with_local_addr(Some(socket.local_addr()?)))
        } else {
            None
        };
        let mut socket = RuntimeUdpSocket::new_with_context(Arc::new(socket), options.context);
        socket.bound_interface = options.bind_device.filter(|name| !name.is_empty());
        *socket.uplink_sockets.get_mut().unwrap() = uplink_sockets;
        socket.uplink_bind = uplink_bind;
        socket._port_lease = port_lease;
        Ok(Arc::new(socket))
    }
}

#[cfg(test)]
mod tests {
    use easytier_core::{
        connectivity::direct::send_udp_hole_punch_packet_with_dns_for_test,
        host::dns::{DnsQuery, DnsResolver},
        packet::UdpPacketType,
        socket::udp::{
            UdpSessionLayer, UdpSessionListenRequest, UdpSessionSocket, parse_udp_session_datagram,
            send_v4_hole_punch_control_packet, send_v6_hole_punch_control_packet,
        },
        socket::{IpVersion, SocketListener},
    };

    use crate::{
        common::{
            config::{ConfigLoader, TomlConfigLoader},
            global_ctx::GlobalCtx,
        },
        host_runtime::native_host_runtime,
        instance::host::native_instance_host,
        proto::peer_rpc::SendUdpHolePunchPacketRequest,
    };

    use super::*;

    fn invalid_manual_uplink() -> SocketContext {
        SocketContext::default().with_uplink(Some(easytier_core::config::uplink::UplinkConfig {
            mode: easytier_core::config::uplink::UplinkMode::Manual,
            interfaces: vec!["et-no-such-uplink".into()],
        }))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn udp_pool_wakes_pending_receive_when_a_new_interface_socket_is_added() {
        for receive_kind in 0..3 {
            let primary = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
            let child = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
            udp_src::enable_recv_pktinfo(&child).unwrap();
            let child_addr = child.local_addr().unwrap();
            let mut socket = RuntimeUdpSocket::new(primary);
            socket.uplink_bind = Some(UdpBindOptions::default());
            let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let receive = tokio::time::timeout(Duration::from_secs(1), async {
                if receive_kind == 0 {
                    let mut payload = [0u8; 32];
                    let (len, _) = socket.recv_from(&mut payload).await.unwrap();
                    assert_eq!(&payload[..len], b"new-interface");
                } else {
                    let datagram = if receive_kind == 1 {
                        socket.recv_datagram().await.unwrap()
                    } else {
                        socket.recv_session_datagram().await.unwrap()
                    };
                    assert_eq!(datagram.payload.as_ref(), b"new-interface");
                }
            });
            let add_and_send = async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                socket.uplink_sockets.write().unwrap().push((123, child));
                socket.receive_waker.wake();
                client.send_to(b"new-interface", child_addr).await.unwrap();
            };
            let (received, _) = tokio::join!(receive, add_and_send);
            received.expect("a newly added UDP backing socket must wake the existing receiver");
        }
    }

    #[tokio::test]
    async fn udp_pool_busy_primary_does_not_starve_another_interface() {
        let primary = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let child = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        udp_src::enable_recv_pktinfo(&child).unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        for _ in 0..10 {
            client
                .send_to(b"primary", primary.local_addr().unwrap())
                .await
                .unwrap();
        }
        client
            .send_to(b"other-interface", child.local_addr().unwrap())
            .await
            .unwrap();
        let mut socket = RuntimeUdpSocket::new(primary);
        socket.uplink_bind = Some(UdpBindOptions::default());
        socket.uplink_sockets.get_mut().unwrap().push((123, child));
        let mut found = false;
        for _ in 0..2 {
            let mut payload = [0u8; 32];
            let (len, _) = socket.recv_from(&mut payload).await.unwrap();
            found |= &payload[..len] == b"other-interface";
        }
        assert!(
            found,
            "a busy first socket must not starve another allowed interface"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn udp_pool_existing_socket_delayed_packet_wakes_each_receive_api() {
        for receive_kind in 0..3 {
            for use_child in [false, true] {
                let primary = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
                let child = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
                udp_src::enable_recv_pktinfo(&child).unwrap();
                let destination = if use_child {
                    child.local_addr().unwrap()
                } else {
                    primary.local_addr().unwrap()
                };
                let mut socket = RuntimeUdpSocket::new(primary);
                socket.uplink_bind = Some(UdpBindOptions::default());
                socket.uplink_sockets.get_mut().unwrap().push((123, child));
                let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
                let receive = tokio::time::timeout(Duration::from_secs(1), async {
                    if receive_kind == 0 {
                        let mut payload = [0u8; 32];
                        let (len, _) = socket.recv_from(&mut payload).await.unwrap();
                        assert_eq!(&payload[..len], b"delayed-packet");
                    } else {
                        let datagram = if receive_kind == 1 {
                            socket.recv_datagram().await.unwrap()
                        } else {
                            socket.recv_session_datagram().await.unwrap()
                        };
                        assert_eq!(datagram.payload.as_ref(), b"delayed-packet");
                    }
                });
                let send = async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    client
                        .send_to(b"delayed-packet", destination)
                        .await
                        .unwrap();
                };
                let started = Instant::now();
                let (result, _) = tokio::join!(receive, send);
                result.expect("an existing primary/backing socket must retain its I/O wakeup");
                // Timeout polls its inner future first. Without a socket
                // waker it could read the queued packet only at the deadline
                // and still return Ok, hiding the lost wakeup regression.
                assert!(
                    started.elapsed() < Duration::from_millis(500),
                    "UDP receive woke only at the timeout deadline"
                );
            }
        }
    }

    #[tokio::test]
    async fn uplink_policy_rejects_missing_interface_before_exposing_udp_socket() {
        let result = RuntimeUdpSocketFactory::new()
            .bind_udp(UdpBindOptions::direct_connect().with_context(invalid_manual_uplink()))
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn automatic_uplink_udp_keeps_loopback_without_allowing_unrestricted_fallback() {
        let context = SocketContext::default()
            .with_uplink(Some(easytier_core::config::uplink::UplinkConfig::default()));
        let no_uplink = match crate::common::uplink::selected_interfaces(&context).await {
            Ok(_) => false,
            Err(error) if error.is::<crate::common::uplink::NoAvailableUplink>() => true,
            Err(error) => panic!("unexpected uplink inventory failure: {error}"),
        };
        let socket = RuntimeUdpSocketFactory::new()
            .bind_udp(UdpBindOptions::direct_connect().with_context(context))
            .await
            .expect("automatic policy must permit local traffic even with no physical uplink");
        assert!(
            socket.socket_context().uplink.is_some(),
            "the wildcard socket must retain its underlay restriction"
        );
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        socket
            .send_to(b"loopback", server.local_addr().unwrap())
            .await
            .unwrap();
        let mut buffer = [0u8; 32];
        let (length, source) =
            tokio::time::timeout(Duration::from_secs(1), server.recv_from(&mut buffer))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(&buffer[..length], b"loopback");
        server.send_to(b"reply", source).await.unwrap();
        let (length, _) =
            tokio::time::timeout(Duration::from_secs(1), socket.recv_from(&mut buffer))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(&buffer[..length], b"reply");
        if no_uplink {
            // In the loopback-only integration namespace this branch exercises
            // the exact outage condition. It never sends a public test packet.
            assert!(
                socket
                    .send_to(b"must-not-send", "203.0.113.1:9".parse().unwrap())
                    .await
                    .is_err()
            );
            assert_ne!(
                socket
                    .destination_allowed(Some("203.0.113.1".parse().unwrap()))
                    .await
                    .ok(),
                Some(true)
            );
        }
        let manual = RuntimeUdpSocketFactory::new()
            .bind_udp(UdpBindOptions::direct_connect().with_context(invalid_manual_uplink()))
            .await;
        assert!(
            manual.is_err(),
            "missing manual uplinks must remain a bind-time error"
        );
    }

    #[tokio::test]
    async fn uplink_policy_does_not_intercept_loopback_control_or_proxy_sockets() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        for options in [
            UdpBindOptions::hole_punch_control()
                .with_need_protect(false)
                .with_local_addr(Some("127.0.0.1:0".parse().unwrap())),
            UdpBindOptions::proxy_nat().with_need_protect(false),
        ] {
            let socket = RuntimeUdpSocketFactory::new()
                .bind_udp(options.with_context(invalid_manual_uplink()))
                .await
                .unwrap();
            assert!(socket.socket_context().uplink.is_none());
            socket
                .send_to(b"local", server.local_addr().unwrap())
                .await
                .unwrap();
            let mut data = [0; 5];
            let (len, _) = server.recv_from(&mut data).await.unwrap();
            assert_eq!(&data[..len], b"local");
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn udp_interface_pktinfo_rejects_unknown_interface_without_sending() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let client = UdpSocket::bind("0.0.0.0:0").await.unwrap();
        let result = udp_src::send_to_with_src_interface(
            &client,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            i32::MAX as u32,
            server.local_addr().unwrap(),
            b"forbidden",
        )
        .await;
        assert!(result.is_err());
        let mut data = [0; 16];
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                server.recv_from(&mut data)
            )
            .await
            .is_err()
        );
        let name = std::ffi::CString::new("lo").unwrap();
        let index = unsafe { nix::libc::if_nametoindex(name.as_ptr()) };
        assert_ne!(index, 0);
        udp_src::send_to_with_src_interface(
            &client,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            index,
            server.local_addr().unwrap(),
            b"allowed",
        )
        .await
        .unwrap();
        let (len, _) = server.recv_from(&mut data).await.unwrap();
        assert_eq!(&data[..len], b"allowed");
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[tokio::test]
    async fn runtime_udp_socket_reports_ipv4_destination_ip() {
        let socket = Arc::new(UdpSocket::bind("0.0.0.0:0").await.unwrap());
        let runtime_socket = RuntimeUdpSocket::new(socket.clone());
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        client
            .send_to(
                b"pktinfo",
                SocketAddr::from(([127, 0, 0, 1], socket.local_addr().unwrap().port())),
            )
            .await
            .unwrap();

        let mut buf = [0; 32];
        let (len, _peer, meta) = runtime_socket.recv_from_with_meta(&mut buf).await.unwrap();

        assert_eq!(&buf[..len], b"pktinfo");
        assert_eq!(meta.dst_ip, Some(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_udp_socket_receives_owned_datagram_with_destination_ip() {
        let socket = Arc::new(UdpSocket::bind("0.0.0.0:0").await.unwrap());
        let runtime_socket = RuntimeUdpSocket::new(socket.clone());
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        client
            .send_to(
                b"owned-pktinfo",
                SocketAddr::from(([127, 0, 0, 1], socket.local_addr().unwrap().port())),
            )
            .await
            .unwrap();

        let datagram = runtime_socket.recv_datagram().await.unwrap();

        assert_eq!(datagram.payload, b"owned-pktinfo".as_slice());
        assert_eq!(
            datagram.meta.dst_ip,
            Some(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_udp_socket_drops_truncated_datagrams() {
        let socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let runtime_socket = RuntimeUdpSocket::new(socket.clone());
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let server_addr = socket.local_addr().unwrap();

        client
            .send_to(&vec![0xAA; MAX_UDP_SESSION_DATAGRAM_SIZE + 1], server_addr)
            .await
            .unwrap();
        client
            .send_to(b"after-oversized", server_addr)
            .await
            .unwrap();

        let datagram = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            runtime_socket.recv_session_datagram(),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(datagram.payload, b"after-oversized".as_slice());
    }

    #[tokio::test]
    async fn runtime_v4_hole_punch_control_packet_is_forwarded() {
        let local_addr = SocketAddr::from(([0, 0, 0, 0], 0));
        let mut listener = new_runtime_udp_session_listener(
            "udp://0.0.0.0:0".parse().unwrap(),
            UdpSessionListenRequest::new(UdpBindOptions::port_bound_listener(local_addr)),
            UdpSessionAcceptKind::EasyTierMux,
            NetNS::new(None),
        );
        listener.listen().await.unwrap();

        let receiver = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let runtime = native_host_runtime();
        send_v4_hole_punch_control_packet(
            runtime.as_ref(),
            SocketContext::default(),
            listener.local_url().port().unwrap(),
            match receiver.local_addr().unwrap() {
                SocketAddr::V4(addr) => addr,
                SocketAddr::V6(_) => unreachable!(),
            },
        )
        .await
        .unwrap();

        let mut buf = [0; 128];
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            receiver.recv_from(&mut buf),
        )
        .await
        .expect("timeout waiting for v4 hole-punch packet")
        .unwrap();
    }

    #[tokio::test]
    async fn runtime_v6_hole_punch_control_packet_is_forwarded() {
        let local_addr = "[::]:0".parse().unwrap();
        let mut listener = new_runtime_udp_session_listener(
            "udp://[::]:0".parse().unwrap(),
            UdpSessionListenRequest::new(UdpBindOptions::port_bound_listener(local_addr)),
            UdpSessionAcceptKind::EasyTierMux,
            NetNS::new(None),
        );
        listener.listen().await.unwrap();

        let receiver = UdpSocket::bind("[::]:0").await.unwrap();
        let runtime = native_host_runtime();
        send_v6_hole_punch_control_packet(
            runtime.as_ref(),
            SocketContext::default(),
            listener.local_url().port().unwrap(),
            match receiver.local_addr().unwrap() {
                SocketAddr::V6(addr) => addr,
                SocketAddr::V4(_) => unreachable!(),
            },
            None,
        )
        .await
        .unwrap();

        let mut buf = [0; 128];
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            receiver.recv_from(&mut buf),
        )
        .await
        .expect("timeout waiting for v6 hole-punch packet")
        .unwrap();
    }

    #[tokio::test]
    async fn mapped_udp_listener_port_forwards_punch_and_preserves_native_handshake() {
        verify_mapped_udp_listener_control(false).await;
    }

    #[tokio::test]
    async fn fqdn_mapped_udp_listener_port_forwards_punch_and_preserves_native_handshake() {
        verify_mapped_udp_listener_control(true).await;
    }

    #[derive(Default)]
    struct GatewayAliasDns {
        queries: std::sync::Mutex<Vec<DnsQuery>>,
    }

    #[async_trait::async_trait]
    impl DnsResolver for GatewayAliasDns {
        async fn resolve(&self, query: DnsQuery) -> anyhow::Result<Vec<IpAddr>> {
            self.queries.lock().unwrap().push(query);
            Ok(vec![
                "198.51.100.10".parse().unwrap(),
                "2001:db8::7".parse().unwrap(),
            ])
        }
    }

    async fn verify_mapped_udp_listener_control(use_dns_alias: bool) {
        for foreign_network in [false, true] {
            for (listener_url, bind_addr, receiver_bind, mapped_host) in [
                (
                    "udp://0.0.0.0:0",
                    "0.0.0.0:0",
                    "127.0.0.1:0",
                    "198.51.100.10",
                ),
                ("udp://[::]:0", "[::]:0", "[::1]:0", "[2001:db8::7]"),
            ] {
                let mut listener = new_runtime_udp_session_listener(
                    listener_url.parse().unwrap(),
                    UdpSessionListenRequest::new(UdpBindOptions::port_bound_listener(
                        bind_addr.parse().unwrap(),
                    )),
                    UdpSessionAcceptKind::EasyTierMux,
                    NetNS::new(None),
                );
                listener.listen().await.unwrap();
                let actual_port = listener.local_url().port().unwrap();
                let alias_port: u16 = if actual_port == 2862 { 2863 } else { 2862 };
                let mapped_host = if use_dns_alias {
                    "gw.example"
                } else {
                    mapped_host
                };
                let alias: url::Url = format!("udp://{mapped_host}:{alias_port}").parse().unwrap();
                let config = TomlConfigLoader::default();
                config.set_mapped_listeners(Some(vec![alias]));
                let host = native_instance_host(Arc::new(GlobalCtx::new(config)));
                let receiver = Arc::new(RuntimeUdpSocket::new(Arc::new(
                    UdpSocket::bind(receiver_bind).await.unwrap(),
                )));
                let receiver_addr = receiver.local_addr().unwrap();
                let dns = Arc::new(GatewayAliasDns::default());
                let resolver: Arc<dyn DnsResolver> = dns.clone();
                let context = SocketContext::default();

                send_udp_hole_punch_packet_with_dns_for_test(
                    host,
                    vec![listener.local_url()],
                    context.clone(),
                    SendUdpHolePunchPacketRequest {
                        connector_addr: Some(receiver_addr.into()),
                        listener_port: u32::from(alias_port),
                        ..Default::default()
                    },
                    foreign_network,
                    use_dns_alias.then_some(resolver),
                )
                .await
                .unwrap();

                let queries = dns.queries.lock().unwrap();
                if use_dns_alias {
                    let family = if receiver_addr.is_ipv6() {
                        IpVersion::V6
                    } else {
                        IpVersion::V4
                    };
                    let expected_context = context.with_ip_version(family);
                    assert!(
                        !queries.is_empty(),
                        "the configured FQDN alias must be resolved"
                    );
                    assert!(queries.iter().all(|query| {
                        query.host == "gw.example" && query.context == expected_context
                    }));
                } else {
                    assert!(queries.is_empty());
                }
                drop(queries);

                let mut buf = [0; 128];
                let (len, source) = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    receiver.recv_from(&mut buf),
                )
                .await
                .expect("the advertised port must deliver control to the actual listener")
                .unwrap();
                let punch =
                    parse_udp_session_datagram(bytes::BytesMut::from(&buf[..len]), false).unwrap();
                assert_eq!(
                    punch.udp_tunnel_header().unwrap().msg_type,
                    UdpPacketType::HolePunch as u8
                );
                assert_eq!(source.port(), actual_port);
                assert_ne!(source.port(), alias_port);

                let layer = UdpSessionLayer::new(receiver.clone());
                let listener_addr = SocketAddr::new(receiver_addr.ip(), actual_port);
                let (connected, accepted) =
                    tokio::time::timeout(std::time::Duration::from_secs(2), async {
                        tokio::join!(layer.connect(listener_addr), listener.accept_session())
                    })
                    .await
                    .expect(
                        "the listener and the same receiver socket must still complete a handshake",
                    );
                assert_eq!(connected.unwrap().peer_addr().unwrap(), listener_addr);
                assert_eq!(accepted.unwrap().peer_addr().unwrap(), receiver_addr);
            }
        }
    }

    #[test]
    fn factory_interprets_bind_defaults_by_purpose() {
        let listener_addr = SocketAddr::from(([0, 0, 0, 0], 11010));
        let factory = RuntimeUdpSocketFactory::new();

        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::port_bound_listener(listener_addr)),
            BindDev::Auto
        ));
        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::direct_connect()),
            BindDev::Auto
        ));
        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::port_forward(listener_addr)),
            BindDev::Auto
        ));
        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::port_lease(listener_addr)),
            BindDev::Disabled
        ));
        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::hole_punch_control()),
            BindDev::Disabled
        ));
        assert_eq!(
            factory.reuse_addr_for(&UdpBindOptions::port_bound_listener(listener_addr)),
            !cfg!(target_os = "windows")
        );
        assert!(!factory.reuse_addr_for(&UdpBindOptions::hole_punch_control()));
        assert_eq!(
            factory.reuse_addr_for(&UdpBindOptions::proxy_nat()),
            !cfg!(target_os = "windows")
        );
        assert_eq!(
            factory.reuse_addr_for(&UdpBindOptions::port_forward(listener_addr)),
            !cfg!(target_os = "windows")
        );
        assert!(!factory.reuse_addr_for(&UdpBindOptions::port_lease(listener_addr)));
    }

    #[test]
    fn factory_applies_listener_bind_device_option() {
        let listener_addr = SocketAddr::from(([0, 0, 0, 0], 11010));
        let factory = RuntimeUdpSocketFactory::new();
        let options = UdpBindOptions::port_bound_listener(listener_addr)
            .with_bind_device(Some("eth0".to_owned()));

        match factory.bind_device_for(&options) {
            BindDev::Custom(dev) => assert_eq!(dev, "eth0"),
            bind_device => panic!("unexpected bind device: {bind_device:?}"),
        }
        assert!(matches!(
            factory.bind_device_for(&UdpBindOptions::hole_punch_control()),
            BindDev::Disabled
        ));
    }
}
