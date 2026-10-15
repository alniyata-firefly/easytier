#[cfg(unix)]
#[path = "udp_src/unix.rs"]
mod platform;

#[cfg(windows)]
#[path = "udp_src/windows.rs"]
mod platform;

#[cfg(not(any(unix, windows)))]
#[path = "udp_src/fallback.rs"]
mod platform;

pub(crate) use platform::*;

/// Send with an explicit source AND output interface. Source-only pktinfo can
/// still follow a different VPN's route and must not implement uplink policy.
pub(crate) async fn send_to_with_src_interface(
    socket: &tokio::net::UdpSocket,
    source: std::net::IpAddr,
    ifindex: u32,
    destination: std::net::SocketAddr,
    data: &[u8],
) -> std::io::Result<usize> {
    use std::{
        io,
        net::{IpAddr, SocketAddr, SocketAddrV4},
    };
    socket
        .async_io(tokio::io::Interest::WRITABLE, || {
            match (source, destination) {
                (IpAddr::V4(source), SocketAddr::V4(destination)) => {
                    platform::send_to_with_src_ipv4_on_interface(
                        socket,
                        source,
                        ifindex,
                        destination.into(),
                        data,
                    )
                }
                (IpAddr::V4(source), SocketAddr::V6(destination))
                    if destination.ip().to_ipv4_mapped().is_some() =>
                {
                    #[cfg(windows)]
                    let destination = SocketAddr::V6(destination);
                    #[cfg(not(windows))]
                    let destination = SocketAddr::V4(SocketAddrV4::new(
                        destination.ip().to_ipv4_mapped().unwrap(),
                        destination.port(),
                    ));
                    platform::send_to_with_src_ipv4_on_interface(
                        socket,
                        source,
                        ifindex,
                        destination,
                        data,
                    )
                }
                (IpAddr::V6(source), SocketAddr::V6(destination)) => {
                    platform::send_to_with_src_ipv6(socket, source, ifindex, destination, data)
                }
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "UDP uplink source and destination families differ",
                )),
            }
        })
        .await
}
