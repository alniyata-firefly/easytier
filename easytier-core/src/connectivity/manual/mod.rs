pub mod discovery;

use std::{
    collections::BTreeSet,
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use async_trait::async_trait;
use dashmap::DashSet;
use percent_encoding::percent_decode_str;
use quanta::Instant;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};
use url::Url;

use crate::tunnel::ring::RingTunnelRegistry;
use crate::{
    connectivity::{
        protocol::{ClientProtocolUpgrader, ProtocolTransport, protocol_transport},
        transport::{self, ConnectedByteStream, ConnectedTransport, UdpSessionMode},
    },
    events::{CoreEvent, CoreEventSink},
    host::dns::{DnsQuery, DnsResolver},
    peers::{PeerConnectionOrigin, peer_manager::PeerManagerCore},
    proto::common::TunnelInfo,
    socket::{
        IpVersion, SocketContext,
        tcp::{TcpBindOptions, TcpSocketPurpose, VirtualTcpSocketFactory},
        udp::{UdpBindOptions, VirtualUdpSocketFactory},
    },
    tunnel::{SplitTunnel, Tunnel, TunnelError},
};

const MANUAL_PREFLIGHT_DEFAULT_PORT: u16 = 1000;
const MAX_MANUAL_ENDPOINT_HOPS: usize = 16;

/// Render transport endpoints without credentials or URL payloads. The real
/// URL continues to be used for discovery, dialing and connector persistence.
pub fn redacted_endpoint_url(url: &Url) -> Url {
    let mut endpoint = url.clone();
    let _ = endpoint.set_username("");
    let _ = endpoint.set_password(None);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    endpoint.set_path(if endpoint.cannot_be_a_base() {
        "<redacted>"
    } else {
        ""
    });
    endpoint
}

fn redacted_endpoint_error(error: &anyhow::Error, endpoint: &Url) -> String {
    let mut message =
        format!("{error:#}").replace(endpoint.as_str(), redacted_endpoint_url(endpoint).as_str());
    // Lower transport layers may report only a path or a query value. Scrub
    // endpoint-owned credential components before exporting their diagnostics.
    let mut sensitive = vec![endpoint.username().to_owned(), endpoint.path().to_owned()];
    sensitive.extend(endpoint.password().map(str::to_owned));
    sensitive.extend(endpoint.query().map(str::to_owned));
    sensitive.extend(endpoint.fragment().map(str::to_owned));
    if let Some(segments) = endpoint.path_segments() {
        sensitive.extend(
            segments
                .filter(|segment| segment.len() >= 8)
                .map(str::to_owned),
        );
    }
    sensitive.extend(
        endpoint
            .query_pairs()
            .map(|(_, value)| value.into_owned())
            .filter(|value| value.len() >= 8),
    );
    for component in sensitive {
        if component.is_empty() || component == "/" {
            continue;
        }
        message = message.replace(&component, "<redacted>");
        if let Ok(decoded) = percent_decode_str(&component).decode_utf8()
            && decoded != component
        {
            message = message.replace(decoded.as_ref(), "<redacted>");
        }
    }
    message
}

fn manual_default_port(url: &Url) -> u16 {
    crate::connectivity::protocol::protocol_default_port(url.scheme()).unwrap_or(11010)
}

fn is_manual_endpoint_scheme(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "txt" | "srv")
}

/// Checks supported connector and discovery schemes without resolving the URL.
pub fn validate_manual_url(url: &Url) -> anyhow::Result<()> {
    if ManualTransport::from_url(url).is_ok() || is_manual_endpoint_scheme(url.scheme()) {
        Ok(())
    } else {
        anyhow::bail!(
            "unsupported core manual connector URL: {}",
            redacted_endpoint_url(url)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManualTransport {
    Tcp(TcpSocketPurpose),
    Udp(UdpSessionMode),
    ByteStream,
}

impl ManualTransport {
    pub(crate) fn from_url(url: &Url) -> anyhow::Result<Self> {
        match protocol_transport(url.scheme()) {
            Some(ProtocolTransport::Tcp) => Ok(Self::Tcp(TcpSocketPurpose::ManualConnect)),
            Some(ProtocolTransport::FakeTcp) => Ok(Self::Tcp(TcpSocketPurpose::FakeTcp)),
            Some(ProtocolTransport::Udp(mode)) => Ok(Self::Udp(mode)),
            None if matches!(url.scheme(), "ring" | "unix") => Ok(Self::ByteStream),
            None => anyhow::bail!(
                "unsupported core manual connector URL: {}",
                redacted_endpoint_url(url)
            ),
        }
    }

    fn is_udp(self) -> bool {
        matches!(self, Self::Udp(_))
    }

    fn supports_interface_bind(self) -> bool {
        !matches!(
            self,
            Self::Tcp(TcpSocketPurpose::FakeTcp) | Self::ByteStream
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualInterfaceAddrs {
    pub interface_ipv4s: Vec<Ipv4Addr>,
    pub interface_ipv6s: Vec<Ipv6Addr>,
    pub public_ipv6: Option<Ipv6Addr>,
}

#[async_trait]
pub trait ManualConnectorHost: VirtualTcpSocketFactory + VirtualUdpSocketFactory {
    fn supports_external_tunnel(&self, _scheme: &str) -> bool {
        false
    }

    async fn connect_external_tunnel(&self, _url: &Url) -> anyhow::Result<Option<Box<dyn Tunnel>>> {
        Ok(None)
    }

    async fn local_addr_for_remote(
        &self,
        remote_addr: SocketAddr,
        context: SocketContext,
    ) -> anyhow::Result<SocketAddr>;

    async fn interface_addrs(&self) -> anyhow::Result<ManualInterfaceAddrs>;

    async fn connect_byte_stream(
        &self,
        url: &Url,
    ) -> anyhow::Result<ConnectedByteStream<<Self as VirtualTcpSocketFactory>::Socket>> {
        anyhow::bail!(
            "host does not support external byte stream: {}",
            redacted_endpoint_url(url)
        )
    }
}

#[async_trait]
pub trait ExternalTunnelConnector: Send + Sync + 'static {
    fn supports_scheme(&self, scheme: &str) -> bool;

    async fn connect(&self, url: &Url) -> anyhow::Result<Box<dyn Tunnel>>;
}

#[async_trait]
pub(crate) trait ManualEndpointResolver: Send + Sync + 'static {
    async fn resolve_endpoint(&self, url: &Url) -> anyhow::Result<Url>;
}

/// Connects one endpoint without owning peer-manager retry or admission policy.
///
/// This is intended for application protocols such as standalone RPC and the
/// configuration client. The host creates transports, while core resolves the
/// endpoint chain and upgrades the resulting socket or session into a tunnel.
pub struct ManualTunnelConnector<H>
where
    H: ManualConnectorHost,
{
    host: Arc<H>,
    dns: Arc<dyn DnsResolver>,
    endpoint_resolver: Arc<dyn ManualEndpointResolver>,
    protocol: Arc<dyn ClientProtocolUpgrader<<H as VirtualTcpSocketFactory>::Socket>>,
    options: ManualConnectorOptions,
    ring_registry: Option<Arc<RingTunnelRegistry>>,
}

impl<H> ManualTunnelConnector<H>
where
    H: ManualConnectorHost,
{
    pub(crate) fn new(
        host: Arc<H>,
        dns: Arc<dyn DnsResolver>,
        endpoint_resolver: Arc<dyn ManualEndpointResolver>,
        protocol: Arc<dyn ClientProtocolUpgrader<<H as VirtualTcpSocketFactory>::Socket>>,
        options: ManualConnectorOptions,
    ) -> Self {
        Self {
            host,
            dns,
            endpoint_resolver,
            protocol,
            options,
            ring_registry: None,
        }
    }

    pub(crate) fn with_ring_registry(mut self, ring_registry: Arc<RingTunnelRegistry>) -> Self {
        self.ring_registry = Some(ring_registry);
        self
    }

    pub async fn connect(
        &self,
        requested_url: Url,
        ip_version: IpVersion,
    ) -> anyhow::Result<Box<dyn Tunnel>> {
        validate_manual_url(&requested_url)?;
        let endpoint = resolve_manual_endpoint(
            self.endpoint_resolver.as_ref(),
            convert_idn_to_ascii(requested_url.clone())?,
        )
        .await?;
        if endpoint.url.scheme() == "ring" {
            let registry = self
                .ring_registry
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("ring registry is not configured"))?;
            let tunnel = connect_ring_tunnel(registry, &endpoint.url)?;
            return Ok(apply_resolved_endpoint_info(
                tunnel,
                requested_url,
                endpoint.tunnel_prefixes,
            ));
        }

        if let Some(tunnel) = self.host.connect_external_tunnel(&endpoint.url).await? {
            return Ok(apply_resolved_endpoint_info(
                tunnel,
                requested_url,
                endpoint.tunnel_prefixes,
            ));
        }

        if !self.protocol.supports_scheme(endpoint.url.scheme()) {
            anyhow::bail!(
                "unsupported client protocol upgrader: {}",
                endpoint.url.scheme()
            );
        }

        let transport = ManualTransport::from_url(&endpoint.url)?;
        let connected = if transport == ManualTransport::ByteStream {
            ConnectedTransport::ByteStream(self.host.connect_byte_stream(&endpoint.url).await?)
        } else {
            let remote_addr = resolve_url_addrs(
                &endpoint.url,
                manual_default_port(&endpoint.url),
                self.options.socket_context(transport, ip_version),
                self.dns.as_ref(),
            )
            .await?
            .choose(&mut rand::thread_rng())
            .copied()
            .ok_or(TunnelError::NoDnsRecordFound(ip_version))?;
            connect_resolved(
                self.host.clone(),
                transport,
                remote_addr,
                Vec::new(),
                self.options.tcp_bind.clone(),
                self.options.udp_bind.clone(),
            )
            .await?
        };

        let tunnel = self
            .protocol
            .upgrade_client(connected, endpoint.url)
            .await?;
        Ok(apply_resolved_endpoint_info(
            tunnel,
            requested_url,
            endpoint.tunnel_prefixes,
        ))
    }
}

struct ResolvedManualTunnel {
    inner: Box<dyn Tunnel>,
    info: TunnelInfo,
}

impl Tunnel for ResolvedManualTunnel {
    fn split(&self) -> SplitTunnel {
        self.inner.split()
    }

    fn info(&self) -> Option<TunnelInfo> {
        Some(self.info.clone())
    }
}

#[derive(Debug)]
struct ResolvedManualEndpoint {
    url: Url,
    tunnel_prefixes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualConnectorStatus {
    Connected,
    Disconnected,
    Connecting,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualConnectorSnapshot {
    pub url: Url,
    pub status: ManualConnectorStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualConnectorOptions {
    pub reconnect_interval: Duration,
    pub connect_timeout: Duration,
    pub endpoint_discovery_timeout: Duration,
    pub bind_device: bool,
    pub allow_interface_bind: bool,
    /// Prefer an IPv6 attempt, with bounded IPv4 fallback for dual-stack URLs.
    #[serde(default)]
    pub prefer_ipv6: bool,
    pub tcp_bind: TcpBindOptions,
    pub udp_bind: UdpBindOptions,
}

impl Default for ManualConnectorOptions {
    fn default() -> Self {
        Self {
            reconnect_interval: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(2),
            endpoint_discovery_timeout: Duration::from_secs(20),
            bind_device: false,
            allow_interface_bind: true,
            prefer_ipv6: false,
            tcp_bind: TcpBindOptions::default(),
            udp_bind: UdpBindOptions::direct_connect(),
        }
    }
}

impl ManualConnectorOptions {
    fn connect_timeout<TcpSocket: 'static>(
        &self,
        url: &Url,
        protocol: &dyn ClientProtocolUpgrader<TcpSocket>,
    ) -> Duration {
        if is_manual_endpoint_scheme(url.scheme()) {
            self.endpoint_discovery_timeout
        } else {
            protocol
                .connect_timeout(url.scheme())
                .unwrap_or(self.connect_timeout)
        }
    }

    pub(crate) fn socket_context(
        &self,
        transport: ManualTransport,
        ip_version: IpVersion,
    ) -> SocketContext {
        let context = match transport {
            ManualTransport::Tcp(_) => self.tcp_bind.context.clone(),
            ManualTransport::Udp(_) => self.udp_bind.context.clone(),
            ManualTransport::ByteStream => SocketContext::default(),
        };
        context.with_ip_version(ip_version)
    }
}

#[derive(Default)]
struct ManualConnectorState {
    connectors: DashSet<Url>,
    reconnecting: DashSet<Url>,
    removed: DashSet<Url>,
    state_lock: Mutex<()>,
}

struct ManualConnectorData<H>
where
    H: ManualConnectorHost,
{
    state: Arc<ManualConnectorState>,
    peer_manager: Weak<PeerManagerCore>,
    host: Arc<H>,
    dns: Arc<dyn DnsResolver>,
    endpoint_resolver: Arc<dyn ManualEndpointResolver>,
    protocol: Arc<dyn ClientProtocolUpgrader<<H as VirtualTcpSocketFactory>::Socket>>,
    ring_registry: Arc<RingTunnelRegistry>,
    events: Arc<dyn CoreEventSink>,
    options: ManualConnectorOptions,
}

pub(crate) struct ManualConnectorManager<H>
where
    H: ManualConnectorHost,
{
    data: Arc<ManualConnectorData<H>>,
    task: Mutex<Option<ManualConnectorTask>>,
}

struct ManualConnectorTask {
    cancel: CancellationToken,
    handle: AbortOnDropHandle<()>,
}

struct ReconnectReservation {
    state: Arc<ManualConnectorState>,
    url: Url,
}

impl ReconnectReservation {
    fn new(state: Arc<ManualConnectorState>, url: Url) -> Self {
        Self { state, url }
    }
}

impl Drop for ReconnectReservation {
    fn drop(&mut self) {
        let _state_guard = self
            .state
            .state_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if finish_reconnect_attempt(&self.state, &self.url) {
            tracing::warn!(url = %redacted_endpoint_url(&self.url), "manual connector removed after reconnect");
        }
    }
}

impl<H> ManualConnectorManager<H>
where
    H: ManualConnectorHost,
{
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        peer_manager: Arc<PeerManagerCore>,
        host: Arc<H>,
        dns: Arc<dyn DnsResolver>,
        endpoint_resolver: Arc<dyn ManualEndpointResolver>,
        protocol: Arc<dyn ClientProtocolUpgrader<<H as VirtualTcpSocketFactory>::Socket>>,
        ring_registry: Arc<RingTunnelRegistry>,
        options: ManualConnectorOptions,
        events: Arc<dyn CoreEventSink>,
    ) -> Self {
        let data = Arc::new(ManualConnectorData {
            state: Arc::new(ManualConnectorState::default()),
            peer_manager: Arc::downgrade(&peer_manager),
            host,
            dns,
            endpoint_resolver,
            protocol,
            ring_registry,
            events,
            options,
        });
        Self {
            data,
            task: Mutex::new(None),
        }
    }

    pub fn start(&self) {
        let mut task_slot = self.task.lock().unwrap();
        if task_slot
            .as_ref()
            .is_some_and(|task| !task.handle.is_finished())
        {
            return;
        }
        let cancel = CancellationToken::new();
        task_slot.replace(ManualConnectorTask {
            handle: AbortOnDropHandle::new(tokio::spawn(Self::run(
                self.data.clone(),
                cancel.clone(),
            ))),
            cancel,
        });
    }

    pub async fn stop(&self) {
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.cancel.cancel();
            let _ = task.handle.await;
        }
        let _state_guard = self.data.state.state_lock.lock().unwrap();
        restore_interrupted_connectors(&self.data.state);
    }

    pub fn add_connector(&self, url: Url) -> anyhow::Result<()> {
        validate_manual_url(&url)?;
        let _state_guard = self.data.state.state_lock.lock().unwrap();
        self.data.state.removed.remove(&url);
        if !self.data.state.reconnecting.contains(&url) {
            self.data.state.connectors.insert(url);
        }
        Ok(())
    }

    pub fn remove_connector(&self, url: &Url) -> bool {
        let _state_guard = self.data.state.state_lock.lock().unwrap();
        if self.data.state.connectors.remove(url).is_some() {
            tracing::warn!(url = %redacted_endpoint_url(url), "manual connector removed");
            return true;
        }
        if self.data.state.reconnecting.contains(url) {
            self.data.state.removed.insert(url.clone());
            return true;
        }
        false
    }

    pub fn clear_connectors(&self) {
        let _state_guard = self.data.state.state_lock.lock().unwrap();
        self.data.state.connectors.clear();
        for url in self.data.state.reconnecting.iter() {
            self.data.state.removed.insert(url.key().clone());
        }
    }

    pub fn list_connectors(&self) -> Vec<ManualConnectorSnapshot> {
        let _state_guard = self.data.state.state_lock.lock().unwrap();
        let peer_manager = self.data.peer_manager.upgrade();
        let mut snapshots = self
            .data
            .state
            .connectors
            .iter()
            .map(|entry| {
                let url = entry.key().clone();
                let connected = peer_manager
                    .as_ref()
                    .is_some_and(|peer_manager| client_url_is_alive(peer_manager, &url));
                ManualConnectorSnapshot {
                    url,
                    status: if connected {
                        ManualConnectorStatus::Connected
                    } else {
                        ManualConnectorStatus::Disconnected
                    },
                }
            })
            .collect::<Vec<_>>();
        snapshots.extend(self.data.state.reconnecting.iter().map(|entry| {
            ManualConnectorSnapshot {
                url: entry.key().clone(),
                status: ManualConnectorStatus::Connecting,
            }
        }));
        snapshots
    }

    async fn run(data: Arc<ManualConnectorData<H>>, cancel: CancellationToken) {
        let mut interval = crate::foundation::time::interval(data.options.reconnect_interval);
        let mut reconnect_tasks = JoinSet::new();

        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = interval.tick() => {
                    for url in take_dead_connectors_for_reconnect(&data) {
                        let task_data = data.clone();
                        let reservation =
                            ReconnectReservation::new(data.state.clone(), url.clone());
                        reconnect_tasks.spawn(async move {
                            let result = reconnect(task_data, url.clone()).await;
                            drop(reservation);
                            (url, result)
                        });
                    }
                }
                result = reconnect_tasks.join_next(), if !reconnect_tasks.is_empty() => {
                    let Some(result) = result else {
                        continue;
                    };
                    match result {
                        Ok((url, reconnect_result)) => {
                            tracing::warn!(url = %redacted_endpoint_url(&url),
                                error = ?reconnect_result.err().map(|error| redacted_endpoint_error(&error, &url)),
                                "manual reconnect task done");
                        }
                        Err(error) => {
                            tracing::error!(?error, "manual reconnect task failed");
                        }
                    }
                }
            }
        }

        reconnect_tasks.abort_all();
        while reconnect_tasks.join_next().await.is_some() {}

        let _state_guard = data.state.state_lock.lock().unwrap();
        restore_interrupted_connectors(&data.state);
    }
}

fn finish_reconnect_attempt(state: &ManualConnectorState, url: &Url) -> bool {
    if state.reconnecting.remove(url).is_none() {
        return false;
    }
    if state.removed.remove(url).is_some() {
        return true;
    }
    state.connectors.insert(url.clone());
    false
}

fn restore_interrupted_connectors(state: &ManualConnectorState) {
    let interrupted = state
        .reconnecting
        .iter()
        .map(|entry| entry.key().clone())
        .collect::<Vec<_>>();
    for url in interrupted {
        finish_reconnect_attempt(state, &url);
    }
}

fn take_dead_connectors_for_reconnect<H>(data: &ManualConnectorData<H>) -> BTreeSet<Url>
where
    H: ManualConnectorHost,
{
    let _state_guard = data.state.state_lock.lock().unwrap();
    let Some(peer_manager) = data.peer_manager.upgrade() else {
        tracing::warn!("peer manager is gone, skip manual reconnect");
        return BTreeSet::new();
    };
    let dead_connectors = data
        .state
        .connectors
        .iter()
        .filter_map(|entry| {
            let url = entry.key();
            (!client_url_is_alive(&peer_manager, url)).then(|| url.clone())
        })
        .collect::<BTreeSet<_>>();
    for url in &dead_connectors {
        let removed = data.state.connectors.remove(url);
        debug_assert!(removed.is_some());
        let inserted = data.state.reconnecting.insert(url.clone());
        debug_assert!(inserted);
    }
    dead_connectors
}

fn client_url_is_alive(peer_manager: &PeerManagerCore, url: &Url) -> bool {
    peer_manager.get_peer_map().is_client_url_alive(url)
        || peer_manager
            .get_foreign_network_client()
            .is_client_url_alive(url)
}

async fn resolve_manual_endpoint(
    resolver: &dyn ManualEndpointResolver,
    requested_url: Url,
) -> anyhow::Result<ResolvedManualEndpoint> {
    let mut url = requested_url;
    let mut tunnel_prefixes = Vec::new();
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(url.clone()) {
            anyhow::bail!(
                "manual endpoint resolution cycle detected at {}",
                redacted_endpoint_url(&url)
            );
        }
        if ManualTransport::from_url(&url).is_ok() {
            return Ok(ResolvedManualEndpoint {
                url,
                tunnel_prefixes,
            });
        }
        if !is_manual_endpoint_scheme(url.scheme()) {
            anyhow::bail!(
                "unsupported resolved manual connector URL: {}",
                redacted_endpoint_url(&url)
            );
        }
        if tunnel_prefixes.len() >= MAX_MANUAL_ENDPOINT_HOPS {
            anyhow::bail!("manual endpoint resolution exceeded {MAX_MANUAL_ENDPOINT_HOPS} hops");
        }
        tunnel_prefixes.push(url.scheme().to_owned());
        url = convert_idn_to_ascii(resolver.resolve_endpoint(&url).await?)?;
    }
}

fn apply_resolved_endpoint_info(
    tunnel: Box<dyn Tunnel>,
    requested_url: Url,
    tunnel_prefixes: Vec<String>,
) -> Box<dyn Tunnel> {
    if tunnel_prefixes.is_empty() {
        return tunnel;
    }
    let inner_info = tunnel.info().unwrap_or_default();
    let tunnel_type = format!("{}-{}", tunnel_prefixes.join("-"), inner_info.tunnel_type);
    Box::new(ResolvedManualTunnel {
        inner: tunnel,
        info: TunnelInfo {
            local_addr: inner_info.local_addr,
            remote_addr: Some(requested_url.into()),
            resolved_remote_addr: inner_info.resolved_remote_addr.or(inner_info.remote_addr),
            tunnel_type,
        },
    })
}

fn connect_ring_tunnel(
    registry: &RingTunnelRegistry,
    endpoint: &Url,
) -> anyhow::Result<Box<dyn Tunnel>> {
    let remote_id = endpoint
        .host_str()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "ring URL has no peer id: {}",
                redacted_endpoint_url(endpoint)
            )
        })?
        .parse()?;
    Ok(registry.connect(remote_id)?.into_tunnel())
}

async fn resolve_reconnect_ip_versions(
    url: &Url,
    connect_timeout: Duration,
    context: SocketContext,
    dns: &dyn DnsResolver,
) -> anyhow::Result<Vec<IpVersion>> {
    if matches!(
        ManualTransport::from_url(url),
        Ok(ManualTransport::ByteStream)
    ) {
        return Ok(vec![IpVersion::Both]);
    }
    if matches!(url.scheme(), "txt" | "srv") {
        return Ok(vec![IpVersion::Both]);
    }

    let addrs = with_timeout_budget(
        "resolve",
        Instant::now(),
        connect_timeout,
        resolve_url_addrs(
            url,
            MANUAL_PREFLIGHT_DEFAULT_PORT,
            context.with_ip_version(IpVersion::Both),
            dns,
        ),
    )
    .await?;
    tracing::info!(?addrs, url = %redacted_endpoint_url(url), "manual preflight resolve done");

    let mut ip_versions = Vec::new();
    if addrs.iter().any(SocketAddr::is_ipv4) {
        ip_versions.push(IpVersion::V4);
    }
    if addrs.iter().any(SocketAddr::is_ipv6) {
        ip_versions.push(IpVersion::V6);
    }
    Ok(ip_versions)
}

async fn reconnect<H>(data: Arc<ManualConnectorData<H>>, url: Url) -> anyhow::Result<()>
where
    H: ManualConnectorHost,
{
    validate_manual_url(&url)?;
    let connect_timeout = data.options.connect_timeout(&url, data.protocol.as_ref());
    tracing::info!(url = %redacted_endpoint_url(&url), "manual reconnect start");
    let normalized_url = match convert_idn_to_ascii(url.clone()) {
        Ok(url) => url,
        Err(error) => {
            emit_connect_error(&data, &url, IpVersion::Both, &error);
            return Err(error);
        }
    };
    let ip_versions = match if data.host.supports_external_tunnel(normalized_url.scheme()) {
        Ok(vec![IpVersion::Both])
    } else {
        resolve_reconnect_ip_versions(
            &normalized_url,
            connect_timeout,
            ManualTransport::from_url(&normalized_url)
                .ok()
                .map(|transport| data.options.socket_context(transport, IpVersion::Both))
                .unwrap_or_default(),
            data.dns.as_ref(),
        )
        .await
    } {
        Ok(ip_versions) => ip_versions,
        Err(error) => {
            emit_connect_error(&data, &url, IpVersion::Both, &error);
            return Err(error);
        }
    };

    // Literal, discovery-only and external transports keep their existing path.
    // A DNS family may contain several addresses; a failed random AAAA must not
    // prevent a second healthy AAAA from being tried.
    if data.options.prefer_ipv6
        && matches!(normalized_url.host(), Some(url::Host::Domain(_)))
        && !data.host.supports_external_tunnel(normalized_url.scheme())
        && matches!(
            ManualTransport::from_url(&normalized_url),
            Ok(ManualTransport::Tcp(_) | ManualTransport::Udp(_))
        )
    {
        let ipv6 =
            reconnect_family_candidates(data.clone(), url.clone(), IpVersion::V6, connect_timeout);
        let ipv4 =
            reconnect_family_candidates(data.clone(), url.clone(), IpVersion::V4, connect_timeout);
        return match (
            ip_versions.contains(&IpVersion::V6),
            ip_versions.contains(&IpVersion::V4),
        ) {
            (true, true) => {
                connect_ipv6_with_fallback(ipv6, ipv4, Duration::from_millis(250), connect_timeout)
                    .await
            }
            (true, false) => ipv6.await,
            (false, true) => ipv4.await,
            (false, false) => Err(anyhow::anyhow!("cannot get IP from URL")),
        };
    }

    if data.options.prefer_ipv6
        && ip_versions.contains(&IpVersion::V6)
        && ip_versions.contains(&IpVersion::V4)
    {
        return connect_ipv6_with_fallback(
            async {
                let result = reconnect_with_ip_version(
                    data.clone(),
                    url.clone(),
                    IpVersion::V6,
                    None,
                    Instant::now(),
                    connect_timeout,
                )
                .await;
                if let Err(error) = &result {
                    emit_connect_error(&data, &url, IpVersion::V6, error);
                }
                result
            },
            async {
                let result = reconnect_with_ip_version(
                    data.clone(),
                    url.clone(),
                    IpVersion::V4,
                    None,
                    Instant::now(),
                    connect_timeout,
                )
                .await;
                if let Err(error) = &result {
                    emit_connect_error(&data, &url, IpVersion::V4, error);
                }
                result
            },
            Duration::from_millis(250),
            connect_timeout,
        )
        .await;
    }

    let mut last_error = anyhow::anyhow!("cannot get IP from URL");
    for ip_version in ip_versions {
        let started_at = Instant::now();
        match reconnect_with_ip_version(
            data.clone(),
            url.clone(),
            ip_version,
            None,
            started_at,
            connect_timeout,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                emit_connect_error(&data, &url, ip_version, &error);
                last_error = error;
            }
        }
    }
    Err(last_error)
}

async fn reconnect_family_candidates<H>(
    data: Arc<ManualConnectorData<H>>,
    requested_url: Url,
    ip_version: IpVersion,
    connect_timeout: Duration,
) -> anyhow::Result<()>
where
    H: ManualConnectorHost,
{
    let started_at = Instant::now();
    let result = async {
        let normalized_url = convert_idn_to_ascii(requested_url.clone())?;
        let transport = ManualTransport::from_url(&normalized_url)?;
        let candidates = with_timeout_budget(
            "resolve",
            started_at,
            connect_timeout,
            resolve_url_addrs(
                &normalized_url,
                manual_default_port(&normalized_url),
                data.options.socket_context(transport, ip_version),
                data.dns.as_ref(),
            ),
        )
        .await?;
        race_resolved_candidates(candidates, started_at, connect_timeout, |remote_addr| {
            reconnect_with_ip_version(
                data.clone(),
                requested_url.clone(),
                ip_version,
                Some(remote_addr),
                started_at,
                connect_timeout,
            )
        })
        .await
    }
    .await;
    if let Err(error) = &result {
        emit_connect_error(&data, &requested_url, ip_version, error);
    }
    result
}

/// All candidates in one family share the same resolve/connect/handshake
/// deadline. The first admitted connection wins; dropping JoinSet cancels the
/// other candidates rather than letting them outlive the reconnect attempt.
async fn race_resolved_candidates<T, F, Fut>(
    candidates: Vec<SocketAddr>,
    started_at: Instant,
    connect_timeout: Duration,
    attempt: F,
) -> anyhow::Result<T>
where
    T: Send + 'static,
    F: Fn(SocketAddr) -> Fut,
    Fut: Future<Output = anyhow::Result<T>> + Send + 'static,
{
    with_timeout_budget("connect", started_at, connect_timeout, async {
        let mut unique = BTreeSet::new();
        let mut tasks = JoinSet::new();
        for candidate in candidates {
            if unique.insert(candidate) {
                tasks.spawn(attempt(candidate));
            }
        }
        let mut last_error = anyhow::anyhow!("no resolved connection candidates");
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => last_error = error,
                Err(error) => last_error = error.into(),
            }
        }
        Err(last_error)
    })
    .await
}

/// Delay polling IPv4 while IPv6 has a short head start. A failed preferred
/// attempt starts the fallback immediately; neither family waits for the
/// other's full connect timeout after the head-start window expires.
async fn connect_ipv6_with_fallback<T>(
    ipv6: impl std::future::Future<Output = anyhow::Result<T>>,
    ipv4: impl std::future::Future<Output = anyhow::Result<T>>,
    delay: Duration,
    preferred_timeout: Duration,
) -> anyhow::Result<T> {
    let ipv6 = async {
        crate::foundation::time::timeout(preferred_timeout, ipv6)
            .await
            .map_err(|_| anyhow::anyhow!("preferred IPv6 connection timed out"))?
    };
    tokio::pin!(ipv6);
    tokio::pin!(ipv4);
    tokio::select! {
        biased;
        result = &mut ipv6 => {
            return match result {
                Ok(value) => Ok(value),
                Err(_) => ipv4.await,
            };
        }
        _ = crate::foundation::time::sleep(delay) => {}
    }
    tokio::select! {
        biased;
        result = &mut ipv6 => match result {
            Ok(value) => Ok(value),
            Err(_) => ipv4.await,
        },
        result = &mut ipv4 => match result {
            // IPv4 has already been admitted and can carry traffic. Keep the
            // bounded IPv6 attempt alive so a slower healthy v6 path can win.
            Ok(value) => Ok(ipv6.await.unwrap_or(value)),
            Err(_) => ipv6.await,
        },
    }
}

async fn reconnect_with_ip_version<H>(
    data: Arc<ManualConnectorData<H>>,
    requested_url: Url,
    ip_version: IpVersion,
    candidate_addr: Option<SocketAddr>,
    started_at: Instant,
    connect_timeout: Duration,
) -> anyhow::Result<()>
where
    H: ManualConnectorHost,
{
    let endpoint = with_timeout_budget(
        "discover",
        started_at,
        connect_timeout,
        resolve_manual_endpoint(
            data.endpoint_resolver.as_ref(),
            convert_idn_to_ascii(requested_url.clone())?,
        ),
    )
    .await?;
    let uses_external_tunnel = data.host.supports_external_tunnel(endpoint.url.scheme());
    if endpoint.url.scheme() != "ring"
        && !uses_external_tunnel
        && !data.protocol.supports_scheme(endpoint.url.scheme())
    {
        anyhow::bail!(
            "unsupported client protocol upgrader: {}",
            endpoint.url.scheme()
        );
    }
    let transport = (endpoint.url.scheme() != "ring" && !uses_external_tunnel)
        .then(|| ManualTransport::from_url(&endpoint.url))
        .transpose()?;
    let resolved = match transport {
        None | Some(ManualTransport::ByteStream) => None,
        Some(transport) => Some(
            with_timeout_budget("resolve", started_at, connect_timeout, async {
                let peer_manager = data.peer_manager.upgrade().ok_or_else(|| {
                    anyhow::anyhow!("peer manager is gone, cannot resolve connector")
                })?;
                let context = data.options.socket_context(transport, ip_version);
                let remote_addr = if let Some(candidate) = candidate_addr {
                    if let Some(reason) = rejected_remote_addr_reason(
                        peer_manager.as_ref(),
                        data.host.as_ref(),
                        &endpoint.url,
                        candidate,
                        context,
                    )
                    .await?
                    {
                        anyhow::bail!("{reason}, refusing overlay-backed underlay connection");
                    }
                    candidate
                } else {
                    resolve_remote_addr(
                        peer_manager.as_ref(),
                        data.host.as_ref(),
                        data.dns.as_ref(),
                        &endpoint.url,
                        manual_default_port(&endpoint.url),
                        context,
                    )
                    .await?
                };
                let bind_addrs = if data.options.bind_device
                    && data.options.allow_interface_bind
                    && transport.supports_interface_bind()
                {
                    collect_bind_addrs(
                        peer_manager.as_ref(),
                        data.host.as_ref(),
                        transport.is_udp(),
                        remote_addr,
                    )
                    .await?
                } else {
                    Vec::new()
                };
                Ok((remote_addr, bind_addrs))
            })
            .await?,
        ),
    };
    data.events.emit(CoreEvent::ManualConnecting {
        url: requested_url.clone(),
    });

    let tunnel = with_timeout_budget("connect", started_at, connect_timeout, async {
        if endpoint.url.scheme() == "ring" {
            return connect_ring_tunnel(&data.ring_registry, &endpoint.url);
        }
        if uses_external_tunnel {
            return data
                .host
                .connect_external_tunnel(&endpoint.url)
                .await?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "host did not provide external tunnel for {}",
                        redacted_endpoint_url(&endpoint.url)
                    )
                });
        }
        let transport = transport.expect("non-Ring endpoint should have a transport");
        let connected = match resolved {
            Some((remote_addr, bind_addrs)) => {
                connect_resolved(
                    data.host.clone(),
                    transport,
                    remote_addr,
                    bind_addrs,
                    data.options.tcp_bind.clone(),
                    data.options.udp_bind.clone(),
                )
                .await?
            }
            None => {
                ConnectedTransport::ByteStream(data.host.connect_byte_stream(&endpoint.url).await?)
            }
        };
        data.protocol.upgrade_client(connected, endpoint.url).await
    })
    .await?;
    let tunnel =
        apply_resolved_endpoint_info(tunnel, requested_url.clone(), endpoint.tunnel_prefixes);
    let peer_manager = data
        .peer_manager
        .upgrade()
        .ok_or_else(|| anyhow::anyhow!("peer manager is gone, cannot reconnect"))?;
    let (peer_id, conn_id) =
        with_timeout_budget("handshake", started_at, connect_timeout, async move {
            peer_manager
                .add_client_tunnel_with_peer_id_hint(tunnel, PeerConnectionOrigin::Manual, None)
                .await
                .map_err(anyhow::Error::from)
        })
        .await?;
    tracing::info!(peer_id, %conn_id, requested_url = %redacted_endpoint_url(&requested_url), "manual reconnect succeeded");
    Ok(())
}

pub(crate) async fn connect_resolved<H>(
    host: Arc<H>,
    transport: ManualTransport,
    remote_addr: SocketAddr,
    bind_addrs: Vec<SocketAddr>,
    tcp_bind: TcpBindOptions,
    udp_bind: UdpBindOptions,
) -> anyhow::Result<ConnectedTransport<<H as VirtualTcpSocketFactory>::Socket>>
where
    H: ManualConnectorHost,
{
    match transport {
        ManualTransport::Tcp(purpose) => {
            transport::connect_tcp(host, remote_addr, bind_addrs, tcp_bind, purpose)
                .await
                .map(ConnectedTransport::Tcp)
        }
        ManualTransport::Udp(mode) => {
            transport::connect_udp(host, remote_addr, bind_addrs, udp_bind, mode)
                .await
                .map(ConnectedTransport::Udp)
        }
        ManualTransport::ByteStream => {
            anyhow::bail!("external byte streams do not use an IP transport address")
        }
    }
}

async fn rejected_remote_addr_reason<H>(
    peer_manager: &PeerManagerCore,
    host: &H,
    url: &Url,
    addr: SocketAddr,
    context: SocketContext,
) -> anyhow::Result<Option<String>>
where
    H: ManualConnectorHost,
{
    let SocketAddr::V6(v6_addr) = addr else {
        return Ok(None);
    };
    if peer_manager.is_easytier_managed_ipv6(v6_addr.ip()).await {
        return Ok(Some(format!(
            "{} resolves to EasyTier-managed IPv6 {}",
            redacted_endpoint_url(url),
            v6_addr.ip()
        )));
    }
    match host.local_addr_for_remote(addr, context).await? {
        SocketAddr::V6(local_addr)
            if peer_manager.is_easytier_managed_ipv6(local_addr.ip()).await =>
        {
            Ok(Some(format!(
                "{} would use EasyTier-managed IPv6 {} as local source for {v6_addr}",
                redacted_endpoint_url(url),
                local_addr.ip()
            )))
        }
        _ => Ok(None),
    }
}

pub(crate) async fn resolve_remote_addr<H>(
    peer_manager: &PeerManagerCore,
    host: &H,
    dns: &dyn DnsResolver,
    url: &Url,
    default_port: u16,
    context: SocketContext,
) -> anyhow::Result<SocketAddr>
where
    H: ManualConnectorHost,
{
    let ip_version = context.ip_version;
    let addrs = resolve_url_addrs(url, default_port, context.clone(), dns).await?;
    let mut usable = Vec::new();
    let mut rejected_reason = None;
    for addr in addrs {
        match rejected_remote_addr_reason(peer_manager, host, url, addr, context.clone()).await? {
            Some(reason) => rejected_reason = Some(reason),
            None => usable.push(addr),
        }
    }

    if usable.is_empty() {
        if let Some(reason) = rejected_reason {
            anyhow::bail!("{reason}, refusing overlay-backed underlay connection");
        }
        return Err(TunnelError::NoDnsRecordFound(ip_version).into());
    }
    usable
        .choose(&mut rand::thread_rng())
        .copied()
        .ok_or_else(|| TunnelError::NoDnsRecordFound(ip_version).into())
}

pub(crate) async fn collect_bind_addrs<H>(
    peer_manager: &PeerManagerCore,
    host: &H,
    is_udp: bool,
    remote_addr: SocketAddr,
) -> anyhow::Result<Vec<SocketAddr>>
where
    H: ManualConnectorHost,
{
    if is_udp && remote_addr.is_ipv6() {
        return Ok(Vec::new());
    }

    let addrs = host.interface_addrs().await?;
    if remote_addr.is_ipv4() {
        return Ok(addrs
            .interface_ipv4s
            .into_iter()
            .map(|addr| SocketAddr::new(IpAddr::V4(addr), 0))
            .collect());
    }

    let mut ipv6s = addrs.interface_ipv6s;
    ipv6s.extend(addrs.public_ipv6);
    let mut ret = Vec::new();
    for addr in ipv6s {
        if !peer_manager.is_easytier_managed_ipv6(&addr).await {
            ret.push(SocketAddr::new(IpAddr::V6(addr), 0));
        }
    }
    Ok(ret)
}

pub(crate) async fn resolve_url_addrs(
    url: &Url,
    default_port: u16,
    context: SocketContext,
    dns: &dyn DnsResolver,
) -> anyhow::Result<Vec<SocketAddr>> {
    let ip_version = context.ip_version;
    let host = url
        .host()
        .ok_or_else(|| anyhow::anyhow!("URL has no host: {}", redacted_endpoint_url(url)))?;
    let port = url.port().unwrap_or(default_port);
    let addrs = match host {
        url::Host::Ipv4(addr) => vec![SocketAddr::new(IpAddr::V4(addr), port)],
        url::Host::Ipv6(addr) => vec![SocketAddr::new(IpAddr::V6(addr), port)],
        url::Host::Domain(host) => dns
            .resolve(DnsQuery::new(host, context))
            .await?
            .into_iter()
            .map(|addr| SocketAddr::new(addr, port))
            .collect(),
    };
    let addrs = addrs
        .into_iter()
        .filter(|addr| match ip_version {
            IpVersion::V4 => addr.is_ipv4(),
            IpVersion::V6 => addr.is_ipv6(),
            IpVersion::Both => true,
        })
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(TunnelError::NoDnsRecordFound(ip_version).into());
    }
    Ok(addrs)
}

pub(crate) fn convert_idn_to_ascii(mut url: Url) -> anyhow::Result<Url> {
    if url.is_special() {
        return Ok(url);
    }
    if let Some(domain) = url.domain() {
        let domain = percent_decode_str(domain).decode_utf8()?;
        let domain = idna::domain_to_ascii(&domain)?;
        url.set_host(Some(&domain))?;
    }
    Ok(url)
}

fn emit_connect_error<H>(
    data: &ManualConnectorData<H>,
    url: &Url,
    ip_version: IpVersion,
    error: &anyhow::Error,
) where
    H: ManualConnectorHost,
{
    data.events.emit(CoreEvent::ManualConnectError {
        url: url.clone(),
        ip_version,
        error: redacted_endpoint_error(error, url),
    });
}

async fn with_timeout_budget<T, F>(
    stage: &'static str,
    started_at: Instant,
    total_timeout: Duration,
    future: F,
) -> anyhow::Result<T>
where
    F: Future<Output = anyhow::Result<T>>,
{
    let remaining = total_timeout
        .checked_sub(started_at.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| anyhow::anyhow!("{stage} timeout after {:?}", started_at.elapsed()))?;
    crate::foundation::time::timeout(remaining, future)
        .await
        .map_err(|_| anyhow::anyhow!("{stage} timeout after {remaining:?}"))?
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::socket::udp::UdpSessionProtocol;

    use super::*;

    #[derive(Clone)]
    struct CanaryLogCapture(Arc<Mutex<String>>);

    impl tracing::Subscriber for CanaryLogCapture {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, event: &tracing::Event<'_>) {
            struct Fields<'a>(&'a mut String);
            impl tracing::field::Visit for Fields<'_> {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    use std::fmt::Write as _;
                    write!(self.0, "{}={value:?} ", field.name()).unwrap();
                }
            }
            event.record(&mut Fields(&mut self.0.lock().unwrap()));
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    #[test]
    fn connector_diagnostics_redact_256_bit_token_without_changing_real_endpoint() {
        use base64::Engine as _;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([29u8; 32]);
        let url = Url::parse(&format!(
            "wss://{token}:{token}@[2001:db8::1]:22020/config/{token}?access={token}#{token}"
        ))
        .unwrap();
        let original = url.clone();
        let endpoint = redacted_endpoint_url(&url);
        assert_eq!(endpoint.host_str(), url.host_str());
        assert_eq!(endpoint.port(), Some(22020));
        assert!(endpoint.username().is_empty());
        assert!(endpoint.password().is_none());
        assert!(endpoint.query().is_none());
        assert!(endpoint.fragment().is_none());
        assert!(!endpoint.as_str().contains(&token));
        let error = anyhow::anyhow!("failed {url}; rejected credential {token}");
        let diagnostic = redacted_endpoint_error(&error, &url);
        assert!(!diagnostic.contains(&token));
        assert!(diagnostic.contains("failed"));
        // Exercise a real reconnect-reservation drop log, rather than only
        // testing the helper's return value.
        let logs = Arc::new(Mutex::new(String::new()));
        let state = Arc::new(ManualConnectorState::default());
        state.reconnecting.insert(url.clone());
        state.removed.insert(url.clone());
        let reservation = ReconnectReservation::new(state, url.clone());
        tracing::subscriber::with_default(CanaryLogCapture(logs.clone()), || drop(reservation));
        let logs = logs.lock().unwrap();
        assert!(logs.contains("manual connector removed after reconnect"));
        assert!(!logs.contains(&token));
        let invalid =
            Url::parse(&format!("unsupported://example.com/{token}?access={token}")).unwrap();
        assert!(
            !validate_manual_url(&invalid)
                .unwrap_err()
                .to_string()
                .contains(&token)
        );
        assert_eq!(url, original);
        assert!(url.path().contains(&token));
    }

    fn reserve_pending_connector(
        state: &Arc<ManualConnectorState>,
        url: &Url,
    ) -> ReconnectReservation {
        let _state_guard = state.state_lock.lock().unwrap();
        assert!(state.connectors.remove(url).is_some());
        assert!(state.reconnecting.insert(url.clone()));
        ReconnectReservation::new(state.clone(), url.clone())
    }

    fn assert_connector_is_pending(state: &ManualConnectorState, url: &Url) {
        assert!(state.connectors.contains(url));
        assert!(!state.reconnecting.contains(url));
        assert!(!state.removed.contains(url));
    }

    #[test]
    fn idn_normalization_covers_connector_schemes_and_url_round_trips() {
        let cases = [
            ("example.com", "example.com"),
            ("test.org:8080/path", "test.org:8080/path"),
            ("räksmörgås.nu", "xn--rksmrgs-5wao1o.nu"),
            ("中文.测试", "xn--fiq228c.xn--0zwm56d"),
            ("räksmörgås.nu:8080", "xn--rksmrgs-5wao1o.nu:8080"),
            ("例子.测试/path", "xn--fsqu00a.xn--0zwm56d/path"),
            ("中文.测试:9000/api", "xn--fiq228c.xn--0zwm56d:9000/api"),
            ("räksmörgås.nu:8080/path", "xn--rksmrgs-5wao1o.nu:8080/path"),
            (
                "中文.测试:8000/用户/管理",
                "xn--fiq228c.xn--0zwm56d:8000/%E7%94%A8%E6%88%B7/%E7%AE%A1%E7%90%86",
            ),
            ("[2001:db8::1]:8080", "[2001:db8::1]:8080"),
            ("[2001:db8::1]/path", "[2001:db8::1]/path"),
            (
                "[2001:db8::1]/路径/资源",
                "[2001:db8::1]/%E8%B7%AF%E5%BE%84/%E8%B5%84%E6%BA%90",
            ),
        ];
        let schemes = ["tcp", "udp", "ws", "wss", "wg", "quic", "http", "https"];

        for (host_part, expected_host_part) in cases {
            for scheme in schemes {
                for round_trip in [false, true] {
                    let input = Url::parse(&format!("{scheme}://{host_part}")).unwrap();
                    let input = if round_trip {
                        input.to_string().parse().unwrap()
                    } else {
                        input
                    };
                    let actual = convert_idn_to_ascii(input.clone()).unwrap().to_string();
                    let mut expected = format!("{scheme}://{expected_host_part}");
                    if input.is_special()
                        && actual.ends_with('/')
                        && !expected_host_part.ends_with('/')
                    {
                        expected.push('/');
                    }
                    assert_eq!(actual, expected, "scheme={scheme}, input={host_part}");
                }
            }
        }
    }

    struct StaticDnsResolver {
        ips: Vec<IpAddr>,
        queries: Mutex<Vec<DnsQuery>>,
    }

    struct ChainedEndpointResolver;

    struct CyclingEndpointResolver;

    #[async_trait]
    impl ManualEndpointResolver for ChainedEndpointResolver {
        async fn resolve_endpoint(&self, url: &Url) -> anyhow::Result<Url> {
            match url.scheme() {
                "http" => Ok("txt://discovery.example".parse().unwrap()),
                "txt" => Ok("tcp://peer.example:12000".parse().unwrap()),
                scheme => anyhow::bail!("unexpected endpoint scheme: {scheme}"),
            }
        }
    }

    #[async_trait]
    impl ManualEndpointResolver for CyclingEndpointResolver {
        async fn resolve_endpoint(&self, url: &Url) -> anyhow::Result<Url> {
            Ok(url.clone())
        }
    }

    #[async_trait]
    impl DnsResolver for StaticDnsResolver {
        async fn resolve(&self, query: DnsQuery) -> anyhow::Result<Vec<IpAddr>> {
            self.queries.lock().unwrap().push(query);
            Ok(self.ips.clone())
        }
    }

    #[test]
    fn manual_transport_maps_ip_protocols_to_their_socket_boundary() {
        let cases = [
            (
                "tcp://127.0.0.1:1",
                ManualTransport::Tcp(TcpSocketPurpose::ManualConnect),
            ),
            (
                "ws://127.0.0.1:1",
                ManualTransport::Tcp(TcpSocketPurpose::ManualConnect),
            ),
            (
                "wss://127.0.0.1:1",
                ManualTransport::Tcp(TcpSocketPurpose::ManualConnect),
            ),
            (
                "faketcp://127.0.0.1:1",
                ManualTransport::Tcp(TcpSocketPurpose::FakeTcp),
            ),
            (
                "udp://127.0.0.1:1",
                ManualTransport::Udp(UdpSessionMode::EasyTierMux),
            ),
            (
                "wg://127.0.0.1:1",
                ManualTransport::Udp(UdpSessionMode::Classified(UdpSessionProtocol::WireGuard)),
            ),
            (
                "quic://127.0.0.1:1",
                ManualTransport::Udp(UdpSessionMode::Classified(UdpSessionProtocol::Quic)),
            ),
            ("ring://local", ManualTransport::ByteStream),
            ("unix:///tmp/easytier.sock", ManualTransport::ByteStream),
        ];

        for (url, expected) in cases {
            assert_eq!(
                ManualTransport::from_url(&url.parse().unwrap()).unwrap(),
                expected
            );
        }
        assert!(ManualTransport::from_url(&"http://127.0.0.1:1".parse().unwrap()).is_err());
        assert!(validate_manual_url(&"http://127.0.0.1:1".parse().unwrap()).is_ok());
    }

    #[tokio::test]
    async fn manual_endpoint_resolution_preserves_the_discovery_chain() {
        let endpoint = resolve_manual_endpoint(
            &ChainedEndpointResolver,
            "http://discovery.example".parse().unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(endpoint.url.as_str(), "tcp://peer.example:12000");
        assert_eq!(endpoint.tunnel_prefixes, ["http", "txt"]);
    }

    #[tokio::test]
    async fn manual_endpoint_resolution_rejects_cycles() {
        let error = resolve_manual_endpoint(
            &CyclingEndpointResolver,
            "http://discovery.example".parse().unwrap(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("cycle detected"));
    }

    #[tokio::test]
    async fn txt_discovery_does_not_require_address_records() {
        let resolver = StaticDnsResolver {
            ips: Vec::new(),
            queries: Mutex::new(Vec::new()),
        };
        let versions = resolve_reconnect_ip_versions(
            &"txt://discovery.example".parse().unwrap(),
            Duration::from_secs(1),
            SocketContext::default(),
            &resolver,
        )
        .await
        .unwrap();

        assert_eq!(versions, [IpVersion::Both]);
        assert!(resolver.queries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn external_byte_stream_does_not_require_address_records() {
        let resolver = StaticDnsResolver {
            ips: Vec::new(),
            queries: Mutex::new(Vec::new()),
        };
        let versions = resolve_reconnect_ip_versions(
            &"ring://local".parse().unwrap(),
            Duration::from_secs(1),
            SocketContext::default(),
            &resolver,
        )
        .await
        .unwrap();

        assert_eq!(versions, [IpVersion::Both]);
        assert!(resolver.queries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn prefer_ipv6_multi_aaaa_recovers_from_first_failure_and_finishes_io() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let bad: SocketAddr = "[2001:db8::1]:11010".parse().unwrap();
        let healthy: SocketAddr = "[2001:db8::2]:11010".parse().unwrap();
        let resolver = StaticDnsResolver {
            ips: vec![bad.ip(), healthy.ip()],
            queries: Mutex::new(Vec::new()),
        };
        let candidates = resolve_url_addrs(
            &"tcp://multi-aaaa.example:11010".parse().unwrap(),
            11010,
            SocketContext::default().with_ip_version(IpVersion::V6),
            &resolver,
        )
        .await
        .unwrap();
        let attempted = Arc::new(Mutex::new(Vec::new()));
        let seen = attempted.clone();
        let winner = race_resolved_candidates(
            candidates,
            Instant::now(),
            Duration::from_secs(1),
            move |address| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(address);
                    if address == bad {
                        return Err(
                            std::io::Error::from(std::io::ErrorKind::ConnectionRefused).into()
                        );
                    }
                    let (mut client, mut server) = tokio::io::duplex(64);
                    let server = tokio::spawn(async move {
                        let mut request = [0u8; 4];
                        server.read_exact(&mut request).await?;
                        if request != *b"ping" {
                            anyhow::bail!("unexpected candidate handshake");
                        }
                        server.write_all(b"pong").await?;
                        Ok::<_, anyhow::Error>(())
                    });
                    client.write_all(b"ping").await?;
                    let mut response = [0u8; 4];
                    client.read_exact(&mut response).await?;
                    server.await??;
                    anyhow::ensure!(response == *b"pong", "candidate handshake did not complete");
                    Ok(address)
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(winner, healthy);
        let attempted = attempted.lock().unwrap();
        assert!(attempted.contains(&bad));
        assert!(attempted.contains(&healthy));
    }

    #[tokio::test]
    async fn prefer_ipv6_multi_aaaa_can_upgrade_after_ipv4_fallback() {
        let hanging: SocketAddr = "[2001:db8::1]:11010".parse().unwrap();
        let healthy: SocketAddr = "[2001:db8::2]:11010".parse().unwrap();
        let fallback: SocketAddr = "127.0.0.1:11010".parse().unwrap();
        let fallback_admitted = std::sync::atomic::AtomicBool::new(false);
        let winner = connect_ipv6_with_fallback(
            race_resolved_candidates(
                vec![hanging, healthy],
                Instant::now(),
                Duration::from_millis(200),
                move |address| async move {
                    if address == hanging {
                        std::future::pending::<()>().await;
                    }
                    crate::foundation::time::sleep(Duration::from_millis(30)).await;
                    Ok(address)
                },
            ),
            async {
                fallback_admitted.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(fallback)
            },
            Duration::from_millis(5),
            Duration::from_millis(200),
        )
        .await
        .unwrap();
        assert!(fallback_admitted.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(winner, healthy);
    }

    #[tokio::test]
    async fn prefer_ipv6_multi_aaaa_shares_one_timeout_budget() {
        let candidates = vec![
            "[2001:db8::1]:11010".parse().unwrap(),
            "[2001:db8::2]:11010".parse().unwrap(),
        ];
        let attempted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = attempted.clone();
        let error = race_resolved_candidates(
            candidates,
            Instant::now(),
            Duration::from_millis(30),
            move |_| {
                let seen = seen.clone();
                async move {
                    seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    std::future::pending::<anyhow::Result<()>>().await
                }
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("connect timeout after"));
        assert_eq!(attempted.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn prefer_ipv6_fast_success_does_not_start_ipv4() {
        let fallback_started = std::sync::atomic::AtomicBool::new(false);
        let result = connect_ipv6_with_fallback(
            async { Ok(6) },
            async {
                fallback_started.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(4)
            },
            Duration::from_millis(250),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result, 6);
        assert!(!fallback_started.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn prefer_ipv6_immediate_failure_does_not_delay_ipv4() {
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            connect_ipv6_with_fallback(
                async { anyhow::bail!("no IPv6 route") },
                async { Ok(4) },
                Duration::from_secs(5),
                Duration::from_secs(1),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, 4);
    }

    #[tokio::test]
    async fn prefer_ipv6_blackhole_has_bounded_ipv4_fallback() {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            connect_ipv6_with_fallback(
                std::future::pending::<anyhow::Result<i32>>(),
                async { Ok(4) },
                Duration::from_millis(20),
                Duration::from_millis(50),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, 4);
    }

    #[tokio::test]
    async fn prefer_ipv6_failed_fallback_keeps_preferred_attempt_alive() {
        let result = connect_ipv6_with_fallback(
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(6)
            },
            async { anyhow::bail!("IPv4 unavailable") },
            Duration::from_millis(5),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(result, 6);
    }

    #[tokio::test]
    async fn prefer_ipv6_can_upgrade_after_ipv4_is_admitted() {
        let admitted_v4 = std::sync::atomic::AtomicBool::new(false);
        let result = connect_ipv6_with_fallback(
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(6)
            },
            async {
                admitted_v4.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(4)
            },
            Duration::from_millis(5),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert!(admitted_v4.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(result, 6);
    }

    #[test]
    fn prefer_ipv6_defaults_off_for_existing_connector_configs() {
        let defaults = ManualConnectorOptions::default();
        assert!(!defaults.prefer_ipv6);
        let mut json = serde_json::to_value(defaults).unwrap();
        json.as_object_mut().unwrap().remove("prefer_ipv6");
        let legacy: ManualConnectorOptions = serde_json::from_value(json).unwrap();
        assert!(!legacy.prefer_ipv6);
    }

    #[test]
    fn external_protocol_and_discovery_timeouts_are_explicit() {
        struct Protocol;

        #[async_trait]
        impl ClientProtocolUpgrader<()> for Protocol {
            fn supports_scheme(&self, scheme: &str) -> bool {
                scheme == "external"
            }

            fn connect_timeout(&self, scheme: &str) -> Option<Duration> {
                (scheme == "external").then_some(Duration::from_secs(20))
            }

            async fn upgrade_client(
                &self,
                _connected: ConnectedTransport<()>,
                _requested_url: Url,
            ) -> anyhow::Result<Box<dyn Tunnel>> {
                unreachable!()
            }
        }

        let options = ManualConnectorOptions::default();
        assert_eq!(
            options.connect_timeout(&"external://127.0.0.1".parse().unwrap(), &Protocol),
            Duration::from_secs(20)
        );
        assert_eq!(
            options.connect_timeout(&"txt://example.com".parse().unwrap(), &Protocol),
            Duration::from_secs(20)
        );
        assert_eq!(
            options.connect_timeout(&"tcp://127.0.0.1".parse().unwrap(), &Protocol),
            Duration::from_secs(2)
        );
    }

    #[tokio::test]
    async fn resolver_receives_instance_socket_context_and_filters_family() {
        let resolver = StaticDnsResolver {
            ips: vec![IpAddr::from([127, 0, 0, 1]), Ipv6Addr::LOCALHOST.into()],
            queries: Mutex::new(Vec::new()),
        };
        let url: Url = "udp://example.com:12000".parse().unwrap();

        let addrs = resolve_url_addrs(
            &url,
            crate::connectivity::protocol::protocol_default_port("tcp").unwrap(),
            SocketContext::default()
                .with_ip_version(IpVersion::V6)
                .with_socket_mark(Some(7)),
            &resolver,
        )
        .await
        .unwrap();

        assert_eq!(addrs, vec!["[::1]:12000".parse().unwrap()]);
        assert_eq!(
            resolver.queries.lock().unwrap().as_slice(),
            &[DnsQuery::new(
                "example.com",
                SocketContext {
                    ip_version: IpVersion::V6,
                    socket_mark: Some(7),
                    netns: None,
                    uplink: None,
                }
            )]
        );
    }

    #[tokio::test]
    async fn timeout_budget_reports_the_active_stage() {
        let error =
            with_timeout_budget("connect", Instant::now(), Duration::from_millis(1), async {
                crate::foundation::time::sleep(Duration::from_millis(20)).await;
                Ok::<(), anyhow::Error>(())
            })
            .await
            .unwrap_err();

        assert!(error.to_string().contains("connect timeout after"));
    }

    #[test]
    fn interrupted_reconnects_return_to_the_pending_set_unless_removed() {
        let state = ManualConnectorState::default();
        let retained: Url = "tcp://127.0.0.1:11010".parse().unwrap();
        let deleted: Url = "udp://127.0.0.1:11010".parse().unwrap();
        state.reconnecting.insert(retained.clone());
        state.reconnecting.insert(deleted.clone());
        state.removed.insert(deleted.clone());

        restore_interrupted_connectors(&state);
        restore_interrupted_connectors(&state);

        assert!(state.connectors.contains(&retained));
        assert!(!state.connectors.contains(&deleted));
        assert!(state.reconnecting.is_empty());
        assert!(state.removed.is_empty());
    }

    #[test]
    fn reconnect_reservation_restores_connector_on_normal_drop() {
        let state = Arc::new(ManualConnectorState::default());
        let url: Url = "tcp://127.0.0.1:11010".parse().unwrap();
        state.connectors.insert(url.clone());

        let reservation = reserve_pending_connector(&state, &url);
        assert!(!state.connectors.contains(&url));
        assert!(state.reconnecting.contains(&url));

        drop(reservation);

        assert_connector_is_pending(&state, &url);
    }

    #[tokio::test]
    async fn reconnect_reservation_restores_connector_after_attempt_panic() {
        let state = Arc::new(ManualConnectorState::default());
        let url: Url = "tcp://127.0.0.1:11010".parse().unwrap();
        state.connectors.insert(url.clone());
        let reservation = reserve_pending_connector(&state, &url);

        let task = tokio::spawn(async move {
            let _reservation = reservation;
            panic!("reconnect attempt panic");
        });
        assert!(task.await.unwrap_err().is_panic());
        assert_connector_is_pending(&state, &url);

        let retry_reservation = reserve_pending_connector(&state, &url);
        drop(retry_reservation);
        assert_connector_is_pending(&state, &url);
    }

    #[tokio::test]
    async fn reconnect_reservation_restores_connector_after_attempt_abort() {
        let state = Arc::new(ManualConnectorState::default());
        let url: Url = "tcp://127.0.0.1:11010".parse().unwrap();
        state.connectors.insert(url.clone());
        let reservation = reserve_pending_connector(&state, &url);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();

        let task = tokio::spawn(async move {
            let _reservation = reservation;
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        started_rx.await.unwrap();
        task.abort();

        assert!(task.await.unwrap_err().is_cancelled());
        assert_connector_is_pending(&state, &url);

        let retry_reservation = reserve_pending_connector(&state, &url);
        drop(retry_reservation);
        assert_connector_is_pending(&state, &url);
    }

    #[test]
    fn reconnect_reservation_does_not_restore_removed_connector() {
        let state = Arc::new(ManualConnectorState::default());
        let url: Url = "tcp://127.0.0.1:11010".parse().unwrap();
        state.connectors.insert(url.clone());
        let reservation = reserve_pending_connector(&state, &url);
        state.removed.insert(url.clone());

        drop(reservation);

        assert!(!state.connectors.contains(&url));
        assert!(!state.reconnecting.contains(&url));
        assert!(!state.removed.contains(&url));
    }
}
