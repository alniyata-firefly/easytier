use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::Arc,
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
}

impl RuntimeUdpSocket {
    #[cfg(test)]
    fn new(socket: Arc<UdpSocket>) -> Self {
        Self::new_with_context(socket, SocketContext::default())
    }

    pub(crate) fn new_with_context(socket: Arc<UdpSocket>, context: SocketContext) -> Self {
        if let Err(err) = udp_src::enable_recv_pktinfo(&socket) {
            tracing::debug!(?err, "enable udp pktinfo failed");
        }
        Self { socket, context }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn socket(&self) -> Arc<UdpSocket> {
        self.socket.clone()
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
        self.socket.send_to(data, addr).await
    }

    async fn recv_from(&self, buf: &mut [u8]) -> std::io::Result<(usize, SocketAddr)> {
        self.socket.recv_from(buf).await
    }

    async fn send_to_with_meta(
        &self,
        data: &[u8],
        addr: SocketAddr,
        meta: UdpSocketSendMeta,
    ) -> std::io::Result<usize> {
        if let (Some(IpAddr::V6(src)), Some(ifindex), SocketAddr::V6(dst)) =
            (meta.src_ip, meta.src_ifindex, addr)
        {
            return udp_src::send_to_with_src_ipv6(&self.socket, src, ifindex, dst, data);
        }
        if let Some(src_ip) = meta.src_ip {
            return udp_src::send_to_with_src_ip(&self.socket, src_ip, addr, data).await;
        }
        self.socket.try_send_to(data, addr)
    }

    async fn recv_from_with_meta(
        &self,
        buf: &mut [u8],
    ) -> std::io::Result<(usize, SocketAddr, UdpSocketRecvMeta)> {
        let (len, addr, dst_ip) = udp_src::recv_from_with_dst_ip(&self.socket, buf).await?;
        Ok((len, addr, UdpSocketRecvMeta { dst_ip }))
    }

    #[cfg(unix)]
    async fn recv_datagram(&self) -> std::io::Result<UdpSocketDatagram> {
        let (payload, remote_addr, dst_ip) =
            udp_src::recv_datagram_with_dst_ip(&self.socket, MAX_UDP_DATAGRAM_SIZE).await?;
        Ok(UdpSocketDatagram {
            payload,
            remote_addr,
            meta: UdpSocketRecvMeta { dst_ip },
        })
    }

    #[cfg(unix)]
    async fn recv_session_datagram(&self) -> std::io::Result<UdpSocketDatagram> {
        let (payload, remote_addr, dst_ip) =
            udp_src::recv_datagram_with_dst_ip(&self.socket, MAX_UDP_SESSION_DATAGRAM_SIZE).await?;
        Ok(UdpSocketDatagram {
            payload,
            remote_addr,
            meta: UdpSocketRecvMeta { dst_ip },
        })
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
    Ok(bind::<UdpSocket>()
        .addr(bind_addr)
        .dev(factory.bind_device_for(options))
        .net_ns(NetNS::from_socket_context(&options.context))
        .only_v6(options.only_v6)
        .reuse_addr(factory.reuse_addr_for(options))
        .reuse_port(options.reuse_port)
        .maybe_socket_mark(options.context.socket_mark)
        .need_protect(options.need_protect)
        .call()
        .await?)
}

#[async_trait]
impl VirtualUdpSocketFactory for RuntimeUdpSocketFactory {
    type Socket = RuntimeUdpSocket;

    async fn bind_udp(&self, options: UdpBindOptions) -> anyhow::Result<Arc<Self::Socket>> {
        let socket = create_udp_socket(&options).await?;
        Ok(Arc::new(RuntimeUdpSocket::new_with_context(
            Arc::new(socket),
            options.context,
        )))
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
