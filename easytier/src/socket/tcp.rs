use std::{
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use easytier_core::{
    socket::SocketContext,
    socket::tcp::{
        TcpBindOptions, TcpConnectOptions, TcpListenOptions, TcpListenPurpose, TcpSocketPurpose,
        VirtualTcpListener, VirtualTcpSocket, VirtualTcpSplit,
    },
    tunnel::TunnelError,
};
use socket2::{SockRef, TcpKeepalive};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpSocket, TcpStream},
};

use crate::{
    common::netns::NetNS,
    socket_protector::protect_native_socket,
    tunnel::common::{BindDev, apply_socket_mark, bind},
};

enum RuntimeTcpSocketInner {
    Tcp(TcpStream),
    #[cfg(unix)]
    Unix(UnixStream),
    #[cfg(feature = "faketcp")]
    FakeTcp(crate::socket::fake_tcp::FakeTcpSocket),
}

pub struct RuntimeTcpSocket {
    inner: RuntimeTcpSocketInner,
}

impl RuntimeTcpSocket {
    pub(crate) fn new(stream: TcpStream) -> Self {
        if let Err(error) = stream.set_nodelay(true) {
            tracing::warn!(?error, "set_nodelay failed for tcp stream");
        }
        Self {
            inner: RuntimeTcpSocketInner::Tcp(stream),
        }
    }

    #[cfg(unix)]
    pub(crate) fn from_unix(stream: UnixStream) -> Self {
        Self {
            inner: RuntimeTcpSocketInner::Unix(stream),
        }
    }

    #[cfg(feature = "faketcp")]
    pub(crate) fn from_fake_tcp(socket: crate::socket::fake_tcp::FakeTcpSocket) -> Self {
        Self {
            inner: RuntimeTcpSocketInner::FakeTcp(socket),
        }
    }
}

#[cfg(unix)]
pub(crate) fn url_from_unix_socket_addr(addr: tokio::net::unix::SocketAddr) -> Option<url::Url> {
    addr.as_pathname()
        .and_then(|path| path.to_str())
        .and_then(|path| format!("unix://{path}").parse().ok())
}

impl AsyncRead for RuntimeTcpSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(stream) => Pin::new(stream).poll_read(cx, buf),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => Pin::new(socket).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for RuntimeTcpSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(stream) => Pin::new(stream).poll_write(cx, buf),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => Pin::new(socket).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(stream) => Pin::new(stream).poll_flush(cx),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => Pin::new(socket).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(stream) => Pin::new(stream).poll_shutdown(cx),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => Pin::new(socket).poll_shutdown(cx),
        }
    }
}

impl VirtualTcpSocket for RuntimeTcpSocket {
    fn into_split(self) -> VirtualTcpSplit {
        match self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => {
                let (reader, writer) = stream.into_split();
                (Box::new(reader), Box::new(writer))
            }
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(stream) => {
                let (reader, writer) = stream.into_split();
                (Box::new(reader), Box::new(writer))
            }
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => {
                let (reader, writer) = tokio::io::split(socket);
                (Box::new(reader), Box::new(writer))
            }
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        match &self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => stream.local_addr(),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unix stream has no IP local address",
            )),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => socket.local_addr(),
        }
    }

    fn peer_addr(&self) -> io::Result<SocketAddr> {
        match &self.inner {
            RuntimeTcpSocketInner::Tcp(stream) => stream.peer_addr(),
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unix stream has no IP peer address",
            )),
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => socket.peer_addr(),
        }
    }

    fn transport_label(&self) -> Option<&str> {
        match &self.inner {
            #[cfg(feature = "faketcp")]
            RuntimeTcpSocketInner::FakeTcp(socket) => socket.transport_label(),
            RuntimeTcpSocketInner::Tcp(_) => None,
            #[cfg(unix)]
            RuntimeTcpSocketInner::Unix(_) => None,
        }
    }
}

#[derive(Debug)]
pub struct RuntimeTcpListener {
    listeners: Vec<TcpListener>,
    local_addr: SocketAddr,
    purpose: TcpListenPurpose,
    need_protect: bool,
    uplink_context: Option<SocketContext>,
    _port_lease: Option<std::sync::Arc<()>>,
}

#[async_trait::async_trait]
impl VirtualTcpListener for RuntimeTcpListener {
    type Socket = RuntimeTcpSocket;

    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.local_addr)
    }

    async fn accept(&self) -> io::Result<(Self::Socket, SocketAddr)> {
        let (stream, addr) = loop {
            use futures::{StreamExt, stream::FuturesUnordered};
            let mut accepts: FuturesUnordered<_> = self
                .listeners
                .iter()
                .map(|listener| listener.accept())
                .collect();
            let (stream, addr) = accepts.next().await.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotConnected,
                    "TCP listener has no bound uplink sockets",
                )
            })??;
            if let Some(context) = &self.uplink_context {
                let local_ip = super::uplink::normalized_ip(stream.local_addr()?.ip());
                if !local_ip.is_loopback()
                    && crate::common::uplink::interface_for_local_ip(context, local_ip)
                        .await
                        .is_err()
                {
                    continue;
                }
            }
            break (stream, addr);
        };
        protect_native_socket(&SockRef::from(&stream), self.need_protect).await?;
        if self.purpose == TcpListenPurpose::ProxyNat {
            prepare_proxy_tcp_socket(&stream)?;
        }
        Ok((RuntimeTcpSocket::new(stream), addr))
    }
}

fn unspecified_bind_addr(remote_addr: SocketAddr) -> SocketAddr {
    match remote_addr {
        SocketAddr::V4(_) => SocketAddr::new(IpAddr::from([0, 0, 0, 0]), 0),
        SocketAddr::V6(_) => SocketAddr::new(IpAddr::from([0, 0, 0, 0, 0, 0, 0, 0]), 0),
    }
}

fn bind_dev_from_options(options: &TcpBindOptions, local_addr_was_defaulted: bool) -> BindDev {
    options
        .bind_device
        .clone()
        .map(BindDev::from)
        .unwrap_or_else(|| {
            if local_addr_was_defaulted {
                BindDev::Disabled
            } else {
                BindDev::Auto
            }
        })
}

async fn bind_tcp_socket(
    remote_addr: SocketAddr,
    bind_options: &TcpBindOptions,
) -> Result<TcpSocket, TunnelError> {
    let (bind_addr, local_addr_was_defaulted) = match bind_options.local_addr {
        Some(addr) => (addr, false),
        None => (unspecified_bind_addr(remote_addr), true),
    };
    let bind_dev = bind_dev_from_options(bind_options, local_addr_was_defaulted);

    bind::<TcpSocket>()
        .addr(bind_addr)
        .dev(bind_dev)
        .net_ns(NetNS::from_socket_context(&bind_options.context))
        .only_v6(bind_options.only_v6)
        .reuse_addr(native_reuse_addr(bind_options))
        .reuse_port(bind_options.reuse_port)
        .maybe_socket_mark(bind_options.context.socket_mark)
        .need_protect(bind_options.need_protect)
        .call()
        .await
}

pub(crate) async fn create_tcp_socket(
    remote_addr: SocketAddr,
    bind_options: &TcpBindOptions,
) -> Result<TcpSocket, TunnelError> {
    if must_bind_before_connect(bind_options) {
        return bind_tcp_socket(remote_addr, bind_options).await;
    }
    // A network namespace is a thread property, but the socket retains its
    // namespace after creation. Never keep the guard across connect().await.
    let socket =
        NetNS::from_socket_context(&bind_options.context).run(|| -> Result<_, TunnelError> {
            let socket = if remote_addr.is_ipv4() {
                TcpSocket::new_v4()?
            } else {
                TcpSocket::new_v6()?
            };
            apply_socket_mark(
                &socket2::SockRef::from(&socket),
                bind_options.context.socket_mark,
            )?;
            Ok(socket)
        })?;
    protect_native_socket(&SockRef::from(&socket), bind_options.need_protect).await?;
    Ok(socket)
}

fn must_bind_before_connect(bind_options: &TcpBindOptions) -> bool {
    bind_options.local_addr.is_some()
        || bind_options.bind_device.is_some()
        || bind_options.reuse_port
        || bind_options.only_v6
        || bind_options
            .reuse_addr
            .is_some_and(|reuse_addr| reuse_addr != native_reuse_addr_default())
}

fn native_reuse_addr_default() -> bool {
    !cfg!(target_os = "windows")
}

fn native_reuse_addr(bind_options: &TcpBindOptions) -> bool {
    bind_options
        .reuse_addr
        .unwrap_or_else(native_reuse_addr_default)
}

pub(crate) async fn bind_tcp_listener(
    options: TcpListenOptions,
) -> Result<RuntimeTcpListener, TunnelError> {
    let purpose = options.purpose;
    let mut bind_options = options.bind;
    let addr = bind_options.local_addr.ok_or_else(|| {
        TunnelError::InvalidAddr("tcp listener requires a local bind address".to_owned())
    })?;
    let uses_uplink = bind_options.context.uplink.is_some()
        && matches!(
            purpose,
            TcpListenPurpose::DirectConnect
                | TcpListenPurpose::HolePunch
                | TcpListenPurpose::ManualConnect
        )
        && !addr.ip().is_loopback();
    if uses_uplink {
        if let Some(device) = super::uplink::validate_local_bind(
            &bind_options.context,
            Some(addr),
            bind_options.bind_device.as_deref(),
        )
        .await?
        {
            if let BindDev::Custom(device) = device {
                bind_options.bind_device = Some(device);
            }
        }
    }
    if bind_options.bind_device.is_none() && purpose == TcpListenPurpose::PortLease {
        bind_options.bind_device = Some(String::new());
    }
    let listeners = if uses_uplink && addr.ip().is_unspecified() {
        bind_uplink_tcp_listeners(addr, &bind_options).await?
    } else {
        vec![create_tcp_socket(addr, &bind_options).await?.listen(1024)?]
    };
    let mut local_addr = addr;
    local_addr.set_port(listeners[0].local_addr()?.port());
    let port_lease = if uses_uplink {
        Some(super::uplink::lease_uplink_port(
            &bind_options.context,
            local_addr,
            bind_options.only_v6,
            super::uplink::UplinkPortProtocol::Tcp,
        )?)
    } else {
        None
    };
    Ok(RuntimeTcpListener {
        listeners,
        local_addr,
        purpose,
        need_protect: bind_options.need_protect,
        uplink_context: uses_uplink.then_some(bind_options.context),
        _port_lease: port_lease,
    })
}

/// A wildcard TCP socket can send SYN-ACK before accept() is called. Restrict
/// every listening socket before listen(), rather than relying on an accepted
/// child's source-address check after the handshake has already happened.
async fn bind_uplink_tcp_listeners(
    requested: SocketAddr,
    options: &TcpBindOptions,
) -> Result<Vec<TcpListener>, TunnelError> {
    let interfaces = crate::common::uplink::selected_interfaces(&options.context).await?;
    let selected_device = options
        .bind_device
        .as_deref()
        .filter(|name| !name.is_empty());
    let mut listeners = Vec::new();
    let mut port = requested.port();
    let mut last_error = None;
    for interface in interfaces {
        if selected_device.is_some_and(|name| name != interface.name) {
            continue;
        }
        // Linux and Apple device-bound listeners keep following address
        // changes on that NIC, including a renewed IPv6 prefix. Windows and
        // Android bind each allowed address because their unicast-interface
        // option alone does not constrain wildcard ingress.
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        let addresses = vec![requested.ip()];
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
        let addresses: Vec<_> = interface
            .addresses
            .iter()
            .map(|address| address.ip())
            .filter(|ip| ip.is_ipv4() == requested.is_ipv4())
            .collect();
        for ip in addresses {
            let mut bind_options = options.clone();
            let address = SocketAddr::new(ip, port);
            bind_options.local_addr = Some(address);
            bind_options.bind_device = Some(interface.name.clone());
            #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
            {
                bind_options.reuse_addr = Some(true);
                bind_options.reuse_port = true;
            }
            match create_tcp_socket(address, &bind_options)
                .await
                .and_then(|socket| socket.listen(1024).map_err(Into::into))
            {
                Ok(listener) => {
                    if port == 0 {
                        port = listener.local_addr()?.port();
                    }
                    listeners.push(listener);
                }
                Err(error) => {
                    tracing::debug!(interface = %interface.name, %address, %error, "uplink TCP listener bind failed");
                    last_error = Some(error);
                }
            }
        }
    }
    if listeners.is_empty() {
        return Err(last_error.unwrap_or_else(|| {
            TunnelError::InvalidAddr(format!(
                "no allowed uplink supports TCP listener {requested}"
            ))
        }));
    }
    Ok(listeners)
}

pub(crate) async fn connect_tcp(
    options: TcpConnectOptions,
) -> Result<RuntimeTcpSocket, TunnelError> {
    let remote_addr = options.remote_addr;
    let purpose = options.purpose;
    let mut bind_options = options.bind;
    if bind_options.context.uplink.is_some()
        && !super::uplink::normalized_ip(remote_addr.ip()).is_loopback()
        && matches!(
            purpose,
            TcpSocketPurpose::DirectConnect
                | TcpSocketPurpose::ManualConnect
                | TcpSocketPurpose::HolePunch
                | TcpSocketPurpose::StunProbe
                | TcpSocketPurpose::DataPlane
        )
    {
        let source = super::uplink::source_for_remote(
            &bind_options.context,
            remote_addr,
            bind_options.local_addr.map(|address| address.ip()),
            bind_options
                .bind_device
                .as_deref()
                .filter(|device| !device.is_empty()),
            bind_options.need_protect,
        )
        .await?;
        let port = bind_options.local_addr.map_or(0, |local| local.port());
        bind_options.local_addr = Some(SocketAddr::new(source.address.ip(), port));
        bind_options.bind_device = Some(source.interface);
    }

    let socket = create_tcp_socket(remote_addr, &bind_options).await?;
    let stream = socket.connect(remote_addr).await?;
    prepare_connected_tcp_socket(&stream, purpose)?;
    Ok(RuntimeTcpSocket::new(stream))
}

fn prepare_connected_tcp_socket(stream: &TcpStream, purpose: TcpSocketPurpose) -> io::Result<()> {
    match purpose {
        TcpSocketPurpose::ProxyNat => prepare_proxy_tcp_socket(stream),
        TcpSocketPurpose::StunProbe => SockRef::from(stream).set_linger(Some(Duration::ZERO)),
        _ => Ok(()),
    }
}

pub(crate) fn prepare_proxy_tcp_socket(stream: &TcpStream) -> io::Result<()> {
    const TCP_KEEPALIVE_TIME: std::time::Duration = std::time::Duration::from_secs(5);
    const TCP_KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
    #[cfg(not(target_os = "windows"))]
    const TCP_KEEPALIVE_RETRIES: u32 = 2;

    let keepalive = TcpKeepalive::new()
        .with_time(TCP_KEEPALIVE_TIME)
        .with_interval(TCP_KEEPALIVE_INTERVAL);

    #[cfg(not(target_os = "windows"))]
    let keepalive = keepalive.with_retries(TCP_KEEPALIVE_RETRIES);

    let socket = SockRef::from(stream);
    socket.set_tcp_keepalive(&keepalive)?;
    if let Err(error) = socket.set_tcp_nodelay(true) {
        tracing::warn!(?error, "set_nodelay failed, ignore it");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::*;

    #[tokio::test]
    async fn tcp_listener_multiplexes_all_bound_uplink_sockets() {
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addresses = [first.local_addr().unwrap(), second.local_addr().unwrap()];
        let listener = RuntimeTcpListener {
            listeners: vec![first, second],
            local_addr: addresses[0],
            purpose: TcpListenPurpose::DirectConnect,
            need_protect: false,
            uplink_context: None,
            _port_lease: None,
        };
        for address in addresses {
            let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
            let mut client = client.unwrap();
            let (mut accepted, _) = accepted.unwrap();
            assert_eq!(accepted.local_addr().unwrap(), address);
            client.write_all(b"uplink").await.unwrap();
            let mut payload = [0; 6];
            accepted.read_exact(&mut payload).await.unwrap();
            assert_eq!(&payload, b"uplink");
        }
    }

    #[tokio::test]
    async fn tcp_uplink_policy_rejects_nonexistent_manual_device_before_connect() {
        let context = SocketContext::default().with_uplink(Some(
            easytier_core::config::uplink::UplinkConfig {
                mode: easytier_core::config::uplink::UplinkMode::Manual,
                interfaces: vec!["et-no-such-uplink".into()],
            },
        ));
        let result = connect_tcp(
            TcpConnectOptions::direct_connect("192.0.2.1:9".parse().unwrap())
                .with_bind(TcpBindOptions::default().with_context(context)),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runtime_tcp_owned_split_preserves_full_duplex_and_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        let client = client.unwrap();
        let (mut server, _) = accepted.unwrap();
        let (mut reader, mut writer) = RuntimeTcpSocket::new(client).into_split();

        writer.write_all(b"client-to-server").await.unwrap();
        let mut from_client = [0; 16];
        server.read_exact(&mut from_client).await.unwrap();
        assert_eq!(&from_client, b"client-to-server");

        server.write_all(b"server-to-client").await.unwrap();
        let mut from_server = [0; 16];
        reader.read_exact(&mut from_server).await.unwrap();
        assert_eq!(&from_server, b"server-to-client");

        writer.shutdown().await.unwrap();
        let mut after_shutdown = [0; 1];
        assert_eq!(server.read(&mut after_shutdown).await.unwrap(), 0);
    }

    #[test]
    fn tcp_connect_binds_when_socket_option_requires_pre_connect_setup() {
        assert!(must_bind_before_connect(
            &TcpBindOptions::default().with_local_addr(Some("127.0.0.1:0".parse().unwrap()))
        ));
        assert!(must_bind_before_connect(
            &TcpBindOptions::default().with_reuse_port(true)
        ));
        assert!(must_bind_before_connect(
            &TcpBindOptions::default().with_only_v6(true)
        ));
        assert!(must_bind_before_connect(
            &TcpBindOptions::default().with_bind_device(Some("eth0".to_owned()))
        ));
        assert!(!must_bind_before_connect(&TcpBindOptions::default()));
        assert!(!must_bind_before_connect(
            &TcpBindOptions::default().with_reuse_addr(native_reuse_addr_default())
        ));
        assert!(must_bind_before_connect(
            &TcpBindOptions::default().with_reuse_addr(!native_reuse_addr_default())
        ));
        assert_eq!(
            native_reuse_addr(&TcpBindOptions::default()),
            native_reuse_addr_default()
        );
    }
}
