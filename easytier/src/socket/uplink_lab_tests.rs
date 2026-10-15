//! Explicit integration lab. The Python launcher creates and destroys two
//! private network namespaces; this test must never run on a normal host.

use std::{
    net::{IpAddr, SocketAddr},
    process::Command,
    time::Duration,
};

use easytier_core::{
    config::uplink::{UplinkConfig, UplinkMode},
    connectivity::composite::ConnectorRuntime,
    socket::{
        SocketContext,
        tcp::{
            TcpBindOptions, TcpConnectOptions, TcpListenOptions, VirtualTcpListener,
            VirtualTcpListenerFactory, VirtualTcpSocket, VirtualTcpSocketFactory,
        },
        udp::{UdpBindOptions, UdpSocketSendMeta, VirtualUdpSocket, VirtualUdpSocketFactory},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::host_runtime::{NativeHostRuntime, native_host_runtime};

const LOCAL_V4: &str = "10.203.0.1";
const LOCAL_V6: &str = "fd69:6c61:6200::1";
const REMOTE_V4: &str = "198.18.0.2:39040";
const REMOTE_V6: &str = "[fd69:6c61:6201::2]:39046";

fn policy(names: &[&str]) -> SocketContext {
    SocketContext::default().with_uplink(Some(UplinkConfig {
        mode: UplinkMode::Manual,
        interfaces: names.iter().map(|name| (*name).to_owned()).collect(),
    }))
}

fn require_isolated_lab() {
    assert_eq!(
        std::env::var("EASYTIER_UPLINK_LAB").as_deref(),
        Ok("1"),
        "run only through script/test-uplink-netns.py"
    );
    let original = std::env::var("EASYTIER_UPLINK_LAB_ORIGINAL_NS")
        .expect("original namespace identity required");
    let current = std::fs::read_link("/proc/self/ns/net")
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_ne!(
        current, original,
        "refusing network changes in the original namespace"
    );
    assert!(
        Command::new("ip")
            .args(["link", "show", "eth0"])
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("ip")
            .args(["link", "show", "wg0"])
            .status()
            .unwrap()
            .success()
    );
}

async fn udp_roundtrip(
    host: &NativeHostRuntime,
    context: &SocketContext,
    remote: SocketAddr,
    marker: &[u8],
) {
    let local: SocketAddr = if remote.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    }
    .parse()
    .unwrap();
    let socket = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_local_addr(Some(local))
                .with_only_v6(true),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        socket.send_to(marker, remote).await.unwrap();
        let mut reply = [0u8; 1024];
        let (length, source) = socket.recv_from(&mut reply).await.unwrap();
        assert_eq!(source, remote);
        assert_eq!(&reply[..length], marker);
    })
    .await
    .expect("allowed-interface UDP round trip timed out");
}

async fn tcp_roundtrip(
    host: &NativeHostRuntime,
    context: &SocketContext,
    remote: SocketAddr,
    marker: &[u8],
) {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut stream = host
            .connect_tcp(
                TcpConnectOptions::direct_connect(remote)
                    .with_bind(TcpBindOptions::default().with_context(context.clone())),
            )
            .await
            .unwrap();
        let expected: IpAddr = if remote.is_ipv4() { LOCAL_V4 } else { LOCAL_V6 }
            .parse()
            .unwrap();
        assert_eq!(stream.local_addr().unwrap().ip(), expected);
        stream.write_all(marker).await.unwrap();
        let mut reply = vec![0u8; marker.len()];
        stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, marker);
    })
    .await
    .expect("allowed-interface TCP round trip timed out");
}

async fn reverse_tcp_roundtrip(host: &NativeHostRuntime, target: &str, marker: &str) {
    let target: IpAddr = target.parse().unwrap();
    let wildcard: SocketAddr = if target.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    }
    .parse()
    .unwrap();
    let context = policy(&["eth0", "eth1"]);
    let listener = host
        .bind_tcp(
            TcpListenOptions::direct_connect(wildcard).with_bind(
                TcpBindOptions::default()
                    .with_context(context.clone())
                    .with_local_addr(Some(wildcard))
                    .with_only_v6(true),
            ),
        )
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 0);
    let request = serde_json::to_vec(&serde_json::json!({"connect_tcp": {"target": target.to_string(), "port": port, "marker": marker}})).unwrap();
    let control_remote: SocketAddr = "198.18.0.2:39049".parse().unwrap();
    let control = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(policy(&["eth0"]))
                .with_local_addr(Some("0.0.0.0:0".parse().unwrap())),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let accept = async {
            let (mut stream, source) = listener.accept().await.unwrap();
            let expected: IpAddr = if target.is_ipv4() {
                "198.18.0.2"
            } else {
                "fd69:6c61:6201::2"
            }
            .parse()
            .unwrap();
            assert_eq!(source.ip(), expected);
            assert_eq!(stream.local_addr().unwrap().ip(), target);
            let mut bytes = vec![0u8; marker.len()];
            stream.read_exact(&mut bytes).await.unwrap();
            assert_eq!(bytes, marker.as_bytes());
            stream.write_all(&bytes).await.unwrap();
        };
        let trigger = async {
            control.send_to(&request, control_remote).await.unwrap();
            let mut reply = [0u8; 1024];
            let (length, source) = control.recv_from(&mut reply).await.unwrap();
            assert_eq!(source, control_remote);
            assert_eq!(&reply[..length], format!("OK:{marker}").as_bytes());
        };
        tokio::join!(accept, trigger);
    })
    .await
    .expect("per-interface wildcard TCP listener failed its reverse route/SYN-ACK test");
}

fn assert_address_in_use<T>(result: anyhow::Result<T>) {
    let error = result
        .err()
        .expect("an independent listener unexpectedly shared an owned port");
    assert!(
        error
            .chain()
            .filter_map(|error| error.downcast_ref::<std::io::Error>())
            .any(|error| error.kind() == std::io::ErrorKind::AddrInUse),
        "expected AddrInUse, got {error:#}"
    );
}

async fn independent_listener_ports_are_exclusive(
    host: &NativeHostRuntime,
    context: &SocketContext,
) {
    let first = host
        .bind_udp(
            UdpBindOptions::port_bound_listener("0.0.0.0:0".parse().unwrap())
                .with_context(context.clone()),
        )
        .await
        .unwrap();
    let port = first.local_addr().unwrap().port();
    let address4 = SocketAddr::new("0.0.0.0".parse().unwrap(), port);
    let address6 = SocketAddr::new("::".parse().unwrap(), port);
    assert_address_in_use(
        host.bind_udp(UdpBindOptions::port_bound_listener(address4).with_context(context.clone()))
            .await,
    );
    assert_address_in_use(
        host.bind_udp(
            UdpBindOptions::port_bound_listener(address6)
                .with_context(context.clone())
                .with_only_v6(false),
        )
        .await,
    );
    let shadow = host
        .bind_udp(
            UdpBindOptions::port_bound_listener(address6)
                .with_context(context.clone())
                .with_only_v6(true),
        )
        .await
        .unwrap();
    drop(first);
    let replacement = host
        .bind_udp(UdpBindOptions::port_bound_listener(address4).with_context(context.clone()))
        .await
        .unwrap();
    drop(replacement);
    drop(shadow);

    let listen = |address| {
        TcpListenOptions::direct_connect(address).with_bind(
            TcpBindOptions::default()
                .with_context(context.clone())
                .with_local_addr(Some(address)),
        )
    };
    let first = host
        .bind_tcp(listen("0.0.0.0:0".parse().unwrap()))
        .await
        .unwrap();
    let address = first.local_addr().unwrap();
    assert_address_in_use(host.bind_tcp(listen(address)).await);
    drop(first);
    let replacement = host.bind_tcp(listen(address)).await.unwrap();
    drop(replacement);
}

fn ip(args: &[&str]) {
    let status = Command::new("ip").args(args).status().unwrap();
    assert!(status.success(), "isolated ip command failed: {args:?}");
}

struct RestoreIpv6;
impl Drop for RestoreIpv6 {
    fn drop(&mut self) {
        let _ = Command::new("ip")
            .args([
                "-6",
                "address",
                "replace",
                "fd69:6c61:6200::1/64",
                "dev",
                "eth0",
                "nodad",
            ])
            .status();
    }
}

#[tokio::test]
#[ignore = "requires explicit isolated namespace lab launcher and CAP_NET_ADMIN"]
async fn allowed_uplink_survives_competing_vpn_routes_and_ipv6_loss() {
    require_isolated_lab();
    let host = native_host_runtime();
    let context = policy(&["eth0"]);

    let inventory = host.collect_ip_addrs(&context).await;
    assert!(!inventory.interface_ipv4s.is_empty());
    assert!(!inventory.interface_ipv6s.is_empty());
    assert!(
        inventory
            .interface_networks
            .iter()
            .all(|network| network.name == "eth0")
    );

    // A normal unpinned OS socket demonstrably follows the misleading route.
    // No application datagram from this check may reach the real echo peer.
    for remote in [REMOTE_V4, REMOTE_V6] {
        let remote: SocketAddr = remote.parse().unwrap();
        let local = if remote.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = tokio::net::UdpSocket::bind(local).await.unwrap();
        socket.connect(remote).await.unwrap();
        let forbidden: IpAddr = if remote.is_ipv4() {
            "10.203.77.1"
        } else {
            "fd69:dead::1"
        }
        .parse()
        .unwrap();
        assert_eq!(socket.local_addr().unwrap().ip(), forbidden);
        socket
            .send(b"baseline-unpinned-must-not-arrive")
            .await
            .unwrap();
        let mut reply = [0u8; 64];
        assert!(
            tokio::time::timeout(Duration::from_millis(250), socket.recv(&mut reply))
                .await
                .is_err()
        );
    }
    println!("UPLINK_LAB baseline_wrong_vpn_route=PASS");

    udp_roundtrip(
        host.as_ref(),
        &context,
        REMOTE_V4.parse().unwrap(),
        b"allowed-udp4-eth0",
    )
    .await;
    udp_roundtrip(
        host.as_ref(),
        &context,
        REMOTE_V6.parse().unwrap(),
        b"allowed-udp6-eth0",
    )
    .await;
    tcp_roundtrip(
        host.as_ref(),
        &context,
        "198.18.0.2:39041".parse().unwrap(),
        b"allowed-tcp4-eth0",
    )
    .await;
    tcp_roundtrip(
        host.as_ref(),
        &context,
        "[fd69:6c61:6201::2]:39047".parse().unwrap(),
        b"allowed-tcp6-eth0",
    )
    .await;
    println!("UPLINK_LAB udp4_udp6_tcp4_tcp6=PASS");

    for (target, marker) in [
        ("10.203.0.1", "reverse-tcp4-eth0"),
        ("10.204.0.1", "reverse-tcp4-eth1"),
        ("fd69:6c61:6200::1", "reverse-tcp6-eth0"),
        ("fd69:6c61:6202::1", "reverse-tcp6-eth1"),
    ] {
        reverse_tcp_roundtrip(host.as_ref(), target, marker).await;
    }
    println!("UPLINK_LAB wildcard_tcp4_tcp6_two_allowed_interfaces_synack_route=PASS");

    independent_listener_ports_are_exclusive(host.as_ref(), &context).await;
    println!("UPLINK_LAB udp_tcp_listener_port_ownership_release_ipv6_shadow=PASS");

    let forbidden_device = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_bind_device(Some("wg0".to_owned())),
        )
        .await;
    assert!(forbidden_device.is_err());
    let forbidden_source = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_local_addr(Some("10.203.77.1:0".parse().unwrap())),
        )
        .await;
    assert!(forbidden_source.is_err());
    let unknown_interface = host
        .bind_udp(UdpBindOptions::direct_connect().with_context(policy(&["missing0"])))
        .await;
    assert!(unknown_interface.is_err());
    let wrong_source6 = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_local_addr(Some("[fd69:dead::1]:0".parse().unwrap())),
        )
        .await;
    assert!(wrong_source6.is_err());
    let forbidden_tcp = host
        .connect_tcp(
            TcpConnectOptions::direct_connect("198.18.0.2:39041".parse().unwrap()).with_bind(
                TcpBindOptions::default()
                    .with_context(context.clone())
                    .with_bind_device(Some("wg0".to_owned())),
            ),
        )
        .await;
    assert!(forbidden_tcp.is_err());
    let socket = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_local_addr(Some("0.0.0.0:0".parse().unwrap())),
        )
        .await
        .unwrap();
    assert!(
        socket
            .send_to_with_meta(
                b"forbidden-explicit-source",
                REMOTE_V4.parse().unwrap(),
                UdpSocketSendMeta {
                    src_ip: Some("10.203.77.1".parse().unwrap()),
                    src_ifindex: None
                }
            )
            .await
            .is_err()
    );
    println!("UPLINK_LAB explicit_source_interface_rejection=PASS");

    ip(&[
        "-6",
        "address",
        "del",
        "fd69:6c61:6200::1/64",
        "dev",
        "eth0",
    ]);
    let _restore = RestoreIpv6;
    let inventory = host.collect_ip_addrs(&context).await;
    assert!(
        inventory.interface_ipv6s.is_empty(),
        "must not substitute the still-present wg0 IPv6"
    );
    assert!(!inventory.interface_ipv4s.is_empty());
    let socket6 = host
        .bind_udp(
            UdpBindOptions::direct_connect()
                .with_context(context.clone())
                .with_local_addr(Some("[::]:0".parse().unwrap()))
                .with_only_v6(true),
        )
        .await;
    if let Ok(socket6) = socket6 {
        assert!(
            socket6
                .send_to(b"ipv6-must-not-use-wg", REMOTE_V6.parse().unwrap())
                .await
                .is_err()
        );
    }
    udp_roundtrip(
        host.as_ref(),
        &context,
        REMOTE_V4.parse().unwrap(),
        b"ipv4-after-ipv6-loss",
    )
    .await;
    println!("UPLINK_LAB ipv6_loss_keeps_allowed_ipv4_no_vpn_fallback=PASS");
}
