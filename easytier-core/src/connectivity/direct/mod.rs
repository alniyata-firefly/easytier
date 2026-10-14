use std::{
    collections::{BTreeSet, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
    sync::{Arc, Weak},
    time::Duration,
};

use anyhow::Context;
use async_trait::async_trait;
use dashmap::DashSet;
use futures::StreamExt;
use quanta::Instant;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::task::JoinSet;
use url::{Host, Url};

use crate::{
    config::PeerId,
    connectivity::hole_punch::policy::{should_background_p2p_with_peer, should_try_p2p_with_peer},
    connectivity::stun::{StunInfoProvider, StunSocketMapper},
    connectivity::{
        LocalListenerUrls,
        protocol::{
            ClientProtocolUpgrader, ProtocolTransport, protocol_transport, protocol_uses_udp,
        },
        transport::{self, ConnectedTransport, UdpSessionMode},
    },
    foundation::expiring_set::ExpiringSet,
    foundation::task::{PeerTaskLauncher, PeerTaskManager},
    host::dns::DnsResolver,
    peers::{
        PeerConnectionOrigin, conn::peer_conn::PeerConnId,
        foreign_network::ForeignNetworkRpcRegistrar, peer_manager::PeerManagerCore,
        peer_rpc::PeerRpcManager,
    },
    process_runtime::ProtectedTcpPortRegistry,
    proto::{
        common::Void,
        peer_rpc::{
            DirectConnectorRpc, DirectConnectorRpcClientFactory,
            DirectConnectorRpcServer as GeneratedDirectConnectorRpcServer, GetIpListRequest,
            GetIpListResponse, SendUdpHolePunchPacketRequest,
        },
        rpc_types::{self, controller::BaseController},
    },
    socket::{
        IpVersion, SocketContext,
        tcp::{TcpBindOptions, TcpSocketPurpose},
        udp::{
            PreferredIpv6Source, UdpBindOptions, VirtualUdpSocket, VirtualUdpSocketFactory,
            send_v4_hole_punch_control_packet, send_v6_hole_punch_control_packet,
        },
    },
    tunnel::Tunnel,
};

use super::manual::{
    ManualConnectorHost, collect_bind_addrs, convert_idn_to_ascii, resolve_remote_addr,
    resolve_url_addrs,
};

mod udp;

const DIRECT_CONNECTOR_BLACKLIST_TIMEOUT: Duration = Duration::from_secs(300);
const INVALID_SERVICE_BLACKLIST_TIMEOUT: Duration = Duration::from_secs(3600);
const DIRECT_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const DIRECT_TASK_LOOP_INTERVAL_MS: u64 = 5000;
const IPV6_HEAD_START: Duration = Duration::from_millis(250);
const IPV6_UPGRADE_RETRY: Duration = Duration::from_secs(60);
const IPV6_PORT_MAPPING_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_IPV6_HOLE_PUNCH_CONNECTOR_ADDRS: usize = 16;
const MAX_UDP_HOLE_PUNCH_CONNECTOR_ADDRS: usize = 16;
const MAX_UDP_HOLE_PUNCH_LISTENER_PORTS: usize = 16;
const UDP_MAPPED_LISTENER_DNS_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_UDP_MAPPED_LISTENER_DNS_QUERIES: usize = 4;

/// Give v6 a bounded head start. Once v4 has established it can already carry
/// packets, while the bounded v6 attempt finishes and may upgrade that peer.
/// Dropping either future cancels its pending work; admitted connections remain.
async fn connect_with_ipv6_head_start<V6, V4>(
    ipv6: V6,
    ipv4: V4,
    head_start: Duration,
) -> anyhow::Result<bool>
where
    V6: std::future::Future<Output = anyhow::Result<()>>,
    V4: std::future::Future<Output = anyhow::Result<()>>,
{
    tokio::pin!(ipv6, ipv4);
    let delay = crate::foundation::time::sleep(head_start);
    tokio::pin!(delay);
    tokio::select! {
        biased;
        result = &mut ipv6 => {
            return match result {
                Ok(()) => Ok(true),
                Err(_) => ipv4.await.map(|()| false),
            };
        }
        _ = &mut delay => {}
    }
    tokio::select! {
        biased;
        result = &mut ipv6 => match result {
            Ok(()) => Ok(true),
            Err(_) => ipv4.await.map(|()| false),
        },
        result = &mut ipv4 => match result {
            Ok(()) => Ok(ipv6.await.is_ok()),
            Err(error) => ipv6.await.map(|()| true).map_err(|_| error),
        },
    }
}

async fn ipv6_udp_punch_addrs<M, C>(local_port: u16, mapping: M, candidates: C) -> Vec<SocketAddr>
where
    M: std::future::Future<Output = anyhow::Result<SocketAddrV6>>,
    C: std::future::Future<Output = anyhow::Result<Vec<Ipv6Addr>>>,
{
    let mapped = match crate::foundation::time::timeout(IPV6_PORT_MAPPING_TIMEOUT, mapping).await {
        Ok(Ok(addr)) => Some(addr),
        Ok(Err(error)) => {
            tracing::debug!(?error, "IPv6 socket STUN mapping unavailable");
            None
        }
        Err(_) => {
            tracing::debug!("IPv6 socket STUN mapping timed out");
            None
        }
    };
    let mut addrs = mapped.map(SocketAddr::V6).into_iter().collect::<Vec<_>>();
    match candidates.await {
        Ok(ips) => {
            for ip in ips {
                // A complete mapping supersedes the local-port guess for its IP.
                if mapped.is_some_and(|addr| *addr.ip() == ip) {
                    continue;
                }
                let addr = SocketAddr::new(IpAddr::V6(ip), local_port);
                if !addrs.contains(&addr) && addrs.len() < MAX_IPV6_HOLE_PUNCH_CONNECTOR_ADDRS {
                    addrs.push(addr);
                }
            }
        }
        Err(error) => tracing::debug!(?error, "IPv6 fallback address collection failed"),
    }
    addrs
}

#[async_trait]
pub trait DirectConnectorHost: ManualConnectorHost {
    async fn collect_ip_addrs(&self, context: &SocketContext) -> GetIpListResponse;

    async fn collect_foreign_ip_addrs(&self, context: &SocketContext) -> GetIpListResponse {
        self.collect_ip_addrs(context).await
    }

    fn mapped_listeners(&self) -> Vec<Url>;

    fn is_local_ip(&self, ip: &IpAddr) -> bool;

    async fn preferred_ipv6_source(
        &self,
        ip: Ipv6Addr,
        context: SocketContext,
    ) -> Option<PreferredIpv6Source>;

    async fn preferred_foreign_ipv6_source(
        &self,
        ip: Ipv6Addr,
        context: SocketContext,
    ) -> Option<PreferredIpv6Source> {
        self.preferred_ipv6_source(ip, context).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectTransport {
    Tcp(TcpSocketPurpose),
    Udp(UdpSessionMode),
}

impl DirectTransport {
    fn from_url(url: &Url) -> anyhow::Result<Self> {
        match protocol_transport(url.scheme()) {
            Some(ProtocolTransport::Tcp) => Ok(Self::Tcp(TcpSocketPurpose::DirectConnect)),
            Some(ProtocolTransport::FakeTcp) => Ok(Self::Tcp(TcpSocketPurpose::FakeTcp)),
            Some(ProtocolTransport::Udp(mode)) => Ok(Self::Udp(mode)),
            None => anyhow::bail!("unsupported direct transport scheme: {}", url.scheme()),
        }
    }

    fn is_udp(self) -> bool {
        matches!(self, Self::Udp(_))
    }

    fn supports_interface_bind(self) -> bool {
        !matches!(self, Self::Tcp(TcpSocketPurpose::FakeTcp))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectConnectorOptions {
    pub default_protocol: String,
    pub enable_ipv6: bool,
    #[serde(default)]
    pub prefer_ipv6: bool,
    pub allow_public_server: bool,
    pub bind_device: bool,
    pub allow_interface_bind: bool,
    pub tcp_bind: TcpBindOptions,
    pub udp_bind: UdpBindOptions,
    #[serde(skip)]
    pub testing: bool,
}

impl Default for DirectConnectorOptions {
    fn default() -> Self {
        Self {
            default_protocol: "tcp".to_owned(),
            enable_ipv6: true,
            prefer_ipv6: false,
            allow_public_server: false,
            bind_device: false,
            allow_interface_bind: true,
            tcp_bind: TcpBindOptions::default(),
            udp_bind: UdpBindOptions::direct_connect(),
            testing: false,
        }
    }
}

impl DirectConnectorOptions {
    fn socket_context(&self, transport: DirectTransport, ip_version: IpVersion) -> SocketContext {
        let context = match transport {
            DirectTransport::Tcp(_) => self.tcp_bind.context.clone(),
            DirectTransport::Udp(_) => self.udp_bind.context.clone(),
        };
        context.with_ip_version(ip_version)
    }
}

#[derive(Debug, Hash, Eq, PartialEq, Clone)]
struct ListenerBlacklistKey(PeerId, String);

#[derive(Default)]
struct Ipv6UpgradeState {
    observed_ipv6: DashSet<PeerId>,
    backoff: ExpiringSet<PeerId>,
}

impl Ipv6UpgradeState {
    fn should_attempt(&self, peer_id: PeerId, ipv6_connected: bool, fallback_alive: bool) -> bool {
        if ipv6_connected {
            self.observed_ipv6.insert(peer_id);
            return false;
        }
        if self.observed_ipv6.remove(&peer_id).is_some() && fallback_alive {
            self.backoff.insert(peer_id, IPV6_UPGRADE_RETRY);
        }
        // A failed upgrade may delay another upgrade, never restoration of a
        // completely disconnected peer.
        !fallback_alive || !self.backoff.contains(&peer_id)
    }

    fn completed(&self, peer_id: PeerId, ipv6_connected: bool, fallback_alive: bool) {
        if ipv6_connected {
            self.observed_ipv6.insert(peer_id);
        } else if fallback_alive {
            self.backoff.insert(peer_id, IPV6_UPGRADE_RETRY);
        }
    }
}

struct DirectConnectorData<H>
where
    H: DirectConnectorHost,
{
    peer_manager: Arc<PeerManagerCore>,
    host: Arc<H>,
    protected_tcp_ports: Arc<ProtectedTcpPortRegistry>,
    stun: Arc<dyn StunSocketMapper<<H as VirtualUdpSocketFactory>::Socket>>,
    running_listeners: Arc<dyn LocalListenerUrls>,
    dns: Arc<dyn DnsResolver>,
    protocol:
        Arc<dyn ClientProtocolUpgrader<<H as crate::socket::tcp::VirtualTcpSocketFactory>::Socket>>,
    options: DirectConnectorOptions,
    listener_blacklist: ExpiringSet<ListenerBlacklistKey>,
    peer_blacklist: ExpiringSet<PeerId>,
    ipv6_upgrades: Ipv6UpgradeState,
}

impl<H> std::fmt::Debug for DirectConnectorData<H>
where
    H: DirectConnectorHost,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectConnectorData")
            .field("peer_id", &self.peer_manager.my_peer_id())
            .field("network_name", &self.peer_manager.network_name())
            .finish()
    }
}

pub(crate) struct DirectConnectorManager<H>
where
    H: DirectConnectorHost,
{
    data: Arc<DirectConnectorData<H>>,
    client: PeerTaskManager<DirectConnectorLauncher<H>>,
}

impl<H> DirectConnectorManager<H>
where
    H: DirectConnectorHost,
{
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_with_running_listeners(
        peer_manager: Arc<PeerManagerCore>,
        host: Arc<H>,
        protected_tcp_ports: Arc<ProtectedTcpPortRegistry>,
        stun: Arc<dyn StunSocketMapper<<H as VirtualUdpSocketFactory>::Socket>>,
        running_listeners: Arc<dyn LocalListenerUrls>,
        dns: Arc<dyn DnsResolver>,
        protocol: Arc<
            dyn ClientProtocolUpgrader<<H as crate::socket::tcp::VirtualTcpSocketFactory>::Socket>,
        >,
        options: DirectConnectorOptions,
    ) -> Self {
        let data = Arc::new(DirectConnectorData {
            peer_manager: peer_manager.clone(),
            host,
            protected_tcp_ports,
            stun,
            running_listeners,
            dns,
            protocol,
            options,
            listener_blacklist: ExpiringSet::default(),
            peer_blacklist: ExpiringSet::default(),
            ipv6_upgrades: Ipv6UpgradeState::default(),
        });
        let client = PeerTaskManager::new_with_external_signal(
            DirectConnectorLauncher(data.clone()),
            Some(peer_manager.p2p_demand_notify()),
        );
        Self { data, client }
    }

    pub fn run(&self) {
        self.run_as_server();
        self.run_as_client();
    }

    pub fn run_as_server(&self) {
        self.data
            .peer_manager
            .get_peer_rpc_mgr()
            .rpc_server()
            .registry()
            .register(
                GeneratedDirectConnectorRpcServer::new(
                    DirectConnectorRpcHandler::new_with_running_listeners_and_stun(
                        self.data.host.clone(),
                        Some(Arc::downgrade(&self.data.peer_manager)),
                        self.data.running_listeners.clone(),
                        self.data.options.udp_bind.context.clone(),
                        Some(self.data.stun.clone()),
                    )
                    .with_dns(self.data.dns.clone()),
                ),
                self.data.peer_manager.network_name(),
            );
    }

    pub fn run_as_client(&self) {
        self.client.start();
    }

    pub async fn stop(&self) {
        self.client.stop().await;
        self.data
            .peer_manager
            .get_peer_rpc_mgr()
            .rpc_server()
            .registry()
            .unregister(
                GeneratedDirectConnectorRpcServer::new(
                    DirectConnectorRpcHandler::new_with_running_listeners_and_stun(
                        self.data.host.clone(),
                        Some(Arc::downgrade(&self.data.peer_manager)),
                        self.data.running_listeners.clone(),
                        self.data.options.udp_bind.context.clone(),
                        Some(self.data.stun.clone()),
                    )
                    .with_dns(self.data.dns.clone()),
                ),
                self.data.peer_manager.network_name(),
            );
    }

    pub(crate) async fn local_address_observations_with_stun(
        &self,
        stun_info: &crate::proto::common::StunInfo,
    ) -> GetIpListResponse {
        collect_address_observations(
            self.data.host.as_ref(),
            Some(self.data.peer_manager.as_ref()),
            &self.data.options.udp_bind.context,
            false,
            Some(stun_info),
        )
        .await
    }
}

struct DirectConnectorLauncher<H>(Arc<DirectConnectorData<H>>)
where
    H: DirectConnectorHost;

impl<H> Clone for DirectConnectorLauncher<H>
where
    H: DirectConnectorHost,
{
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[async_trait]
impl<H> PeerTaskLauncher for DirectConnectorLauncher<H>
where
    H: DirectConnectorHost,
{
    type CollectPeerItem = PeerId;
    type TaskRet = ();

    async fn collect_peers_need_task(&self) -> Vec<PeerId> {
        let data = &self.0;
        data.peer_blacklist.cleanup();
        data.ipv6_upgrades.backoff.cleanup();
        let my_peer_id = data.peer_manager.my_peer_id();
        let policy = data.peer_manager.p2p_policy_flags();
        let now = Instant::now();
        data.peer_manager
            .get_route()
            .list_routes()
            .await
            .into_iter()
            .filter(|route| {
                let static_allowed = should_background_p2p_with_peer(
                    route.feature_flag.as_ref(),
                    data.options.allow_public_server,
                    policy.lazy_p2p,
                    policy.disable_p2p,
                    policy.need_p2p,
                );
                let dynamic_allowed = should_try_p2p_with_peer(
                    route.feature_flag.as_ref(),
                    data.options.allow_public_server,
                    policy.disable_p2p,
                    policy.need_p2p,
                ) && data.peer_manager.has_recent_traffic(route.peer_id, now);
                route.peer_id != my_peer_id
                    && (static_allowed || dynamic_allowed)
                    && if data.prefers_ipv6() {
                        data.ipv6_upgrades.should_attempt(
                            route.peer_id,
                            data.has_ipv6_connection(route.peer_id),
                            data.has_live_connection(route.peer_id),
                        )
                    } else {
                        !data.peer_manager.has_directly_connected_conn(route.peer_id)
                    }
                    && !data.peer_blacklist.contains(&route.peer_id)
            })
            .map(|route| route.peer_id)
            .collect()
    }

    async fn launch_task(&self, peer_id: PeerId) -> tokio::task::JoinHandle<anyhow::Result<()>> {
        let data = self.0.clone();
        tokio::spawn(async move { data.try_direct_connect(peer_id).await })
    }

    fn loop_interval_ms(&self) -> u64 {
        DIRECT_TASK_LOOP_INTERVAL_MS
    }
}

impl<H> DirectConnectorData<H>
where
    H: DirectConnectorHost,
{
    fn prefers_ipv6(&self) -> bool {
        self.options.enable_ipv6 && self.options.prefer_ipv6
    }

    fn has_ipv6_connection(&self, peer_id: PeerId) -> bool {
        self.peer_manager
            .get_peer_map()
            .get_peer_by_id(peer_id)
            .or_else(|| {
                self.peer_manager
                    .get_foreign_network_client()
                    .get_peer_map()
                    .get_peer_by_id(peer_id)
            })
            .is_some_and(|peer| peer.has_live_ipv6_connection())
    }

    fn has_live_connection(&self, peer_id: PeerId) -> bool {
        self.peer_manager
            .get_peer_map()
            .get_peer_by_id(peer_id)
            .or_else(|| {
                self.peer_manager
                    .get_foreign_network_client()
                    .get_peer_map()
                    .get_peer_by_id(peer_id)
            })
            .is_some_and(|peer| peer.has_live_conns())
    }

    async fn try_direct_connect(self: Arc<Self>, dst_peer_id: PeerId) -> anyhow::Result<()> {
        let backoffs_ms = [1000, 2000, 2000, 5000, 5000, 10000, 30000, 60000];
        let mut backoff_index = 0usize;
        let mut attempt = 0usize;

        loop {
            if self.peer_blacklist.contains(&dst_peer_id) {
                anyhow::bail!("peer {dst_peer_id} is blacklisted");
            }
            if attempt > 0 {
                crate::foundation::time::sleep(Duration::from_millis(backoffs_ms[backoff_index]))
                    .await;
                backoff_index = (backoff_index + 1).min(backoffs_ms.len() - 1);
            }
            attempt += 1;

            let rpc_stub = self
                .peer_manager
                .get_peer_rpc_mgr()
                .rpc_client()
                .scoped_client::<DirectConnectorRpcClientFactory<BaseController>>(
                self.peer_manager.my_peer_id(),
                dst_peer_id,
                self.peer_manager.network_name().to_owned(),
            );
            let ip_list = match rpc_stub
                .get_ip_list(BaseController::default(), GetIpListRequest {})
                .await
            {
                Ok(ip_list) => ip_list,
                Err(error @ rpc_types::error::Error::InvalidServiceKey(_, _)) => {
                    self.peer_blacklist
                        .insert(dst_peer_id, INVALID_SERVICE_BLACKLIST_TIMEOUT);
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            };

            tracing::info!(?ip_list, dst_peer_id, "got direct-connect IP list");
            let result = self
                .try_direct_connect_with_ip_list(dst_peer_id, ip_list)
                .await;
            tracing::info!(?result, dst_peer_id, "direct-connect attempt returned");
            if self.peer_manager.has_directly_connected_conn(dst_peer_id)
                || (self.prefers_ipv6() && self.has_live_connection(dst_peer_id))
            {
                if self.prefers_ipv6() {
                    // The existing IPv4 connection remains usable. Retry upgrades
                    // independently per peer, without tearing down a working path.
                    self.ipv6_upgrades.completed(
                        dst_peer_id,
                        self.has_ipv6_connection(dst_peer_id),
                        self.has_live_connection(dst_peer_id),
                    );
                }
                return Ok(());
            }
        }
    }

    async fn try_direct_connect_with_ip_list(
        self: &Arc<Self>,
        dst_peer_id: PeerId,
        ip_list: GetIpListResponse,
    ) -> anyhow::Result<()> {
        if !self.prefers_ipv6() {
            return self
                .try_direct_connect_with_ip_list_legacy(dst_peer_id, ip_list)
                .await;
        }
        if self.has_ipv6_connection(dst_peer_id) {
            return Ok(());
        }

        let ipv4 = async {
            let listeners = self
                .preferred_family_targets(&ip_list, IpVersion::V4)
                .await?;
            if listeners.is_empty() {
                if self.peer_manager.has_directly_connected_conn(dst_peer_id) {
                    return Ok(());
                }
                anyhow::bail!("no usable IPv4 direct listener");
            }
            self.try_direct_connect_with_ip_list_legacy(
                dst_peer_id,
                GetIpListResponse {
                    listeners: listeners.into_iter().map(Into::into).collect(),
                    ..Default::default()
                },
            )
            .await?;
            anyhow::ensure!(
                self.peer_manager.has_directly_connected_conn(dst_peer_id),
                "IPv4 direct connection did not establish"
            );
            Ok(())
        };

        // Literal IPv4-only listeners cannot provide a v6 path. Do not delay
        // those peers just because another peer in this network supports v6.
        let may_have_ipv6 = ip_list.listeners.iter().any(|listener| {
            Url::parse(&listener.url)
                .is_ok_and(|url| matches!(url.host(), Some(Host::Ipv6(_)) | Some(Host::Domain(_))))
        });
        if !may_have_ipv6 {
            return ipv4.await;
        }

        let ipv6 = async {
            crate::foundation::time::timeout(DIRECT_CONNECT_TIMEOUT, async {
                let listeners = self
                    .preferred_family_targets(&ip_list, IpVersion::V6)
                    .await?;
                self.try_ipv6_targets(dst_peer_id, listeners).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("IPv6 direct attempt timed out"))?
        };
        connect_with_ipv6_head_start(ipv6, ipv4, IPV6_HEAD_START)
            .await
            .map(|_| ())
    }

    async fn preferred_family_targets(
        &self,
        ip_list: &GetIpListResponse,
        family: IpVersion,
    ) -> anyhow::Result<Vec<Url>> {
        let local_listeners = self.running_listeners.local_listener_urls();
        let mut targets = Vec::new();
        let mut seen = HashSet::new();
        for raw in &ip_list.listeners {
            let listener: Url = raw.clone().into();
            if listener.scheme() == "ring"
                || listener.host().is_none()
                || mapped_listener_port(&listener).is_none()
            {
                continue;
            }
            if matches!(listener.host(), Some(Host::Ipv4(_))) && family == IpVersion::V6
                || matches!(listener.host(), Some(Host::Ipv6(_))) && family == IpVersion::V4
            {
                continue;
            }
            let context = self
                .options
                .tcp_bind
                .context
                .clone()
                .with_ip_version(family);
            let Ok(addrs) = resolve_url_addrs(
                &listener,
                mapped_listener_port(&listener).unwrap(),
                context,
                self.dns.as_ref(),
            )
            .await
            else {
                continue;
            };
            let is_udp = protocol_uses_udp(listener.scheme());
            let port = mapped_listener_port(&listener).unwrap();
            for addr in addrs {
                let ips: Vec<IpAddr> = match addr.ip() {
                    IpAddr::V4(ip) if ip.is_unspecified() => ip_list
                        .interface_ipv4s
                        .iter()
                        .chain(ip_list.public_ipv4.iter())
                        .map(|ip| IpAddr::V4(ip.addr.into()))
                        .collect(),
                    IpAddr::V6(ip) if ip.is_unspecified() => ip_list
                        .interface_ipv6s
                        .iter()
                        .chain(ip_list.public_ipv6.iter())
                        .map(|ip| IpAddr::V6(Ipv6Addr::from(*ip)))
                        .collect(),
                    ip => vec![ip],
                };
                for ip in ips {
                    if ip.is_unspecified()
                        || ip.is_multicast()
                        || (ip.is_loopback() && !self.options.testing)
                    {
                        continue;
                    }
                    let protected = local_listeners.iter().any(|local| {
                        local.port() == Some(port) && protocol_uses_udp(local.scheme()) == is_udp
                    }) || (!is_udp && self.protected_tcp_ports.contains(port));
                    if protected && self.host.is_local_ip(&ip) {
                        continue;
                    }
                    if let IpAddr::V6(remote) = ip {
                        if remote.to_ipv4_mapped().is_some()
                            || remote.is_unicast_link_local()
                            || self.peer_manager.is_easytier_managed_ipv6(&remote).await
                        {
                            continue;
                        }
                        let Ok(transport) = DirectTransport::from_url(&listener) else {
                            continue;
                        };
                        let Ok(SocketAddr::V6(local)) = self
                            .host
                            .local_addr_for_remote(
                                SocketAddr::new(ip, port),
                                self.options.socket_context(transport, IpVersion::V6),
                            )
                            .await
                        else {
                            continue;
                        };
                        if local.ip().is_unspecified()
                            || self.peer_manager.is_easytier_managed_ipv6(local.ip()).await
                        {
                            continue;
                        }
                    }
                    let mut url = listener.clone();
                    if url.set_ip_host(ip).is_ok() && seen.insert(url.to_string()) {
                        targets.push(url);
                    }
                }
            }
        }
        Ok(targets)
    }

    async fn try_ipv6_targets(
        self: &Arc<Self>,
        dst_peer_id: PeerId,
        targets: Vec<Url>,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!targets.is_empty(), "no usable IPv6 direct listener");
        let mut tasks = JoinSet::new();
        for url in targets {
            let data = self.clone();
            tasks.spawn(async move { data.connect_to_url_once(dst_peer_id, url.as_str()).await });
        }
        let mut last_error = anyhow::anyhow!("no IPv6 direct attempt completed");
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(_)) => return Ok(()),
                Ok(Err(error)) => last_error = error,
                Err(error) => last_error = error.into(),
            }
        }
        Err(last_error)
    }

    async fn try_direct_connect_with_ip_list_legacy(
        self: &Arc<Self>,
        dst_peer_id: PeerId,
        ip_list: GetIpListResponse,
    ) -> anyhow::Result<()> {
        let mut available_listeners = ip_list
            .listeners
            .clone()
            .into_iter()
            .map(Into::<Url>::into)
            .filter(|listener| listener.scheme() != "ring")
            .filter(|listener| {
                mapped_listener_port(listener).is_some() && listener.host().is_some()
            })
            .filter(|listener| {
                self.options.enable_ipv6 || !matches!(listener.host(), Some(Host::Ipv6(_)))
            })
            .collect::<Vec<_>>();

        if available_listeners.is_empty() {
            anyhow::bail!("peer {dst_peer_id} has no valid listener");
        }

        available_listeners.sort_by_key(|listener| {
            if listener.scheme() == self.options.default_protocol {
                3
            } else if listener.scheme() == "udp" {
                2
            } else {
                1
            }
        });

        while !available_listeners.is_empty() {
            let mut tasks = JoinSet::new();
            let current_scheme = available_listeners
                .last()
                .expect("non-empty listener list")
                .scheme()
                .to_owned();
            while available_listeners
                .last()
                .is_some_and(|listener| listener.scheme() == current_scheme)
            {
                let listener = available_listeners.pop().expect("listener should exist");
                self.spawn_direct_connect_tasks(dst_peer_id, &ip_list, &listener, &mut tasks)
                    .await;
            }
            let _ = tasks.join_all().await;
            if self.peer_manager.has_directly_connected_conn(dst_peer_id) {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn spawn_direct_connect_tasks(
        self: &Arc<Self>,
        dst_peer_id: PeerId,
        ip_list: &GetIpListResponse,
        listener: &Url,
        tasks: &mut JoinSet<anyhow::Result<()>>,
    ) {
        let Ok(mut addrs) = resolve_mapped_listener_addrs(
            listener,
            self.options.tcp_bind.context.clone(),
            self.dns.as_ref(),
        )
        .await
        else {
            tracing::error!(?listener, "failed to resolve direct listener");
            return;
        };
        let listener_host = addrs.pop();
        let is_udp = protocol_uses_udp(listener.scheme());
        let local_listeners = self.running_listeners.local_listener_urls();
        let port_has_local_listener = |port: u16| {
            local_listeners.iter().any(|local| {
                local.port() == Some(port) && protocol_uses_udp(local.scheme()) == is_udp
            })
        };
        let should_deny_target = |target: &SocketAddr| {
            let port_is_protected = port_has_local_listener(target.port())
                || (!is_udp && self.protected_tcp_ports.contains(target.port()));
            port_is_protected && self.host.is_local_ip(&target.ip())
        };

        match listener_host {
            Some(SocketAddr::V4(socket_addr)) if socket_addr.ip().is_unspecified() => {
                for ip in ip_list
                    .interface_ipv4s
                    .iter()
                    .chain(ip_list.public_ipv4.iter())
                {
                    let target = SocketAddr::new(IpAddr::V4(ip.addr.into()), socket_addr.port());
                    if should_deny_target(&target) {
                        continue;
                    }
                    let mut url = listener.clone();
                    if url.set_ip_host(target.ip()).is_ok() {
                        tasks.spawn(Self::try_connect_to_url(
                            self.clone(),
                            dst_peer_id,
                            url.to_string(),
                        ));
                    }
                }
            }
            Some(SocketAddr::V4(socket_addr))
                if (!socket_addr.ip().is_loopback() || self.options.testing)
                    && !should_deny_target(&SocketAddr::V4(socket_addr)) =>
            {
                tasks.spawn(Self::try_connect_to_url(
                    self.clone(),
                    dst_peer_id,
                    listener.to_string(),
                ));
            }
            Some(SocketAddr::V6(socket_addr)) if socket_addr.ip().is_unspecified() => {
                let mut candidates = HashSet::new();
                for ip in ip_list
                    .interface_ipv6s
                    .iter()
                    .chain(ip_list.public_ipv6.iter())
                    .map(|ip| Ipv6Addr::from(*ip))
                {
                    if self.is_usable_public_ipv6(&ip).await {
                        candidates.insert(ip);
                    }
                }
                for ip in candidates {
                    let target = SocketAddr::new(IpAddr::V6(ip), socket_addr.port());
                    if should_deny_target(&target) {
                        continue;
                    }
                    let mut url = listener.clone();
                    if url.set_ip_host(target.ip()).is_ok() {
                        tasks.spawn(Self::try_connect_to_url(
                            self.clone(),
                            dst_peer_id,
                            url.to_string(),
                        ));
                    }
                }
            }
            Some(SocketAddr::V6(socket_addr))
                if self
                    .peer_manager
                    .is_easytier_managed_ipv6(socket_addr.ip())
                    .await =>
            {
                tracing::debug!(?listener, "skip managed IPv6 direct target");
            }
            Some(SocketAddr::V6(socket_addr))
                if (!socket_addr.ip().is_loopback() || self.options.testing)
                    && !should_deny_target(&SocketAddr::V6(socket_addr)) =>
            {
                tasks.spawn(Self::try_connect_to_url(
                    self.clone(),
                    dst_peer_id,
                    listener.to_string(),
                ));
            }
            _ => {}
        }
    }

    async fn try_connect_to_url(
        self: Arc<Self>,
        dst_peer_id: PeerId,
        url: String,
    ) -> anyhow::Result<()> {
        self.listener_blacklist.cleanup();
        let key = ListenerBlacklistKey(dst_peer_id, url.clone());
        if self.listener_blacklist.contains(&key) {
            anyhow::bail!("direct listener URL is blacklisted");
        }

        let backoffs_ms = [1000i64, 2000, 4000];
        for attempt in 0..=backoffs_ms.len() {
            if self.peer_manager.has_directly_connected_conn(dst_peer_id) {
                return Ok(());
            }
            let result = self.connect_to_url_once(dst_peer_id, &url).await;
            if result.is_ok() || self.peer_manager.has_directly_connected_conn(dst_peer_id) {
                return Ok(());
            }
            if attempt == backoffs_ms.len() {
                self.listener_blacklist
                    .insert(key, DIRECT_CONNECTOR_BLACKLIST_TIMEOUT);
                return result;
            }

            let base = backoffs_ms[attempt];
            let delta = base >> 1;
            let delay_ms = {
                let mut rng = rand::thread_rng();
                base + rng.gen_range(-delta..delta)
            };
            crate::foundation::time::sleep(Duration::from_millis(delay_ms as u64)).await;
        }
        unreachable!("direct URL retry loop must return")
    }

    async fn connect_to_url_once(&self, dst_peer_id: PeerId, raw_url: &str) -> anyhow::Result<()> {
        let url = Url::parse(raw_url)?;
        let (peer_id, conn_id) = match public_udp_punch_family(&url) {
            Some(IpVersion::V6) => self.connect_public_ipv6(dst_peer_id, &url).await?,
            Some(IpVersion::V4) => match self.connect_public_ipv4(dst_peer_id, &url).await {
                Ok(result) => result,
                Err(error) => {
                    tracing::debug!(?error, %url, "public IPv4 UDP punch failed; fallback");
                    self.connect_ordinary(dst_peer_id, url.clone()).await?
                }
            },
            _ => self.connect_ordinary(dst_peer_id, url.clone()).await?,
        };

        if peer_id != dst_peer_id && !self.options.testing {
            self.peer_manager.close_peer_conn(peer_id, &conn_id).await?;
            anyhow::bail!("direct peer mismatch for {url}: expected {dst_peer_id}, got {peer_id}");
        }
        Ok(())
    }

    async fn connect_ordinary(
        &self,
        dst_peer_id: PeerId,
        url: Url,
    ) -> anyhow::Result<(PeerId, PeerConnId)> {
        let transport = DirectTransport::from_url(&url)?;
        let normalized = convert_idn_to_ascii(url.clone())?;
        let default_port = mapped_listener_port(&normalized)
            .ok_or_else(|| anyhow::anyhow!("listener has no port: {url}"))?;
        let remote_addr = resolve_remote_addr(
            self.peer_manager.as_ref(),
            self.host.as_ref(),
            self.dns.as_ref(),
            &normalized,
            default_port,
            self.options.socket_context(transport, IpVersion::Both),
        )
        .await?;
        let bind_addrs = if self.options.bind_device
            && self.options.allow_interface_bind
            && transport.supports_interface_bind()
        {
            collect_bind_addrs(
                self.peer_manager.as_ref(),
                self.host.as_ref(),
                transport.is_udp(),
                remote_addr,
            )
            .await?
        } else {
            Vec::new()
        };
        crate::foundation::time::timeout(DIRECT_CONNECT_TIMEOUT, async {
            let connected = match transport {
                DirectTransport::Tcp(purpose) => ConnectedTransport::Tcp(
                    transport::connect_tcp(
                        self.host.clone(),
                        remote_addr,
                        bind_addrs,
                        self.options.tcp_bind.clone(),
                        purpose,
                    )
                    .await?,
                ),
                DirectTransport::Udp(mode) => ConnectedTransport::Udp(
                    transport::connect_udp(
                        self.host.clone(),
                        remote_addr,
                        bind_addrs,
                        self.options.udp_bind.clone(),
                        mode,
                    )
                    .await?,
                ),
            };
            let tunnel = self.protocol.upgrade_client(connected, url).await?;
            self.admit(tunnel, dst_peer_id).await
        })
        .await?
    }

    async fn connect_public_ipv4(
        &self,
        dst_peer_id: PeerId,
        url: &Url,
    ) -> anyhow::Result<(PeerId, PeerConnId)> {
        let socket = self
            .host
            .bind_udp(
                UdpBindOptions::direct_connect()
                    .with_context(
                        self.options
                            .udp_bind
                            .context
                            .clone()
                            .with_ip_version(IpVersion::V4),
                    )
                    .with_local_addr(Some("0.0.0.0:0".parse().unwrap())),
            )
            .await?;
        let connector_addr = self
            .stun
            .get_udp_port_mapping_with_socket(socket.clone())
            .await?;
        let _ = self
            .remote_send_udp_hole_punch_packet(dst_peer_id, vec![connector_addr], None, url)
            .await;
        let remote_addr = resolve_literal_url(url, IpVersion::V4)?;
        let connected = udp::connect_with_socket(self.host.clone(), socket, remote_addr).await?;
        let tunnel = self
            .protocol
            .upgrade_client(ConnectedTransport::Udp(connected), url.clone())
            .await?;
        self.admit(tunnel, dst_peer_id).await
    }

    async fn connect_public_ipv6(
        &self,
        dst_peer_id: PeerId,
        url: &Url,
    ) -> anyhow::Result<(PeerId, PeerConnId)> {
        let socket = self
            .host
            .bind_udp(
                UdpBindOptions::direct_connect()
                    .with_context(
                        self.options
                            .udp_bind
                            .context
                            .clone()
                            .with_ip_version(IpVersion::V6),
                    )
                    .with_local_addr(Some("[::]:0".parse().unwrap())),
            )
            .await?;
        let connector_addrs = ipv6_udp_punch_addrs(
            socket.local_addr()?.port(),
            async {
                match self
                    .stun
                    .get_udp_port_mapping_with_socket(socket.clone())
                    .await?
                {
                    SocketAddr::V6(addr)
                        if addr.port() != 0
                            && addr.ip().to_ipv4_mapped().is_none()
                            && self.is_usable_public_ipv6(addr.ip()).await =>
                    {
                        Ok(addr)
                    }
                    addr => anyhow::bail!("no usable IPv6 UDP mapping: {addr}"),
                }
            },
            self.collect_ipv6_hole_punch_candidates(),
        )
        .await;
        if !connector_addrs.is_empty() {
            let preferred_src = match url.host() {
                Some(Host::Ipv6(ip)) => Some(ip),
                _ => None,
            };
            let _ = self
                .remote_send_udp_hole_punch_packet(dst_peer_id, connector_addrs, preferred_src, url)
                .await;
        }
        let remote_addr = resolve_literal_url(url, IpVersion::V6)?;
        let connected = udp::connect_with_socket(self.host.clone(), socket, remote_addr).await?;
        let tunnel = self
            .protocol
            .upgrade_client(ConnectedTransport::Udp(connected), url.clone())
            .await?;
        self.admit(tunnel, dst_peer_id).await
    }

    async fn collect_ipv6_hole_punch_candidates(&self) -> anyhow::Result<Vec<Ipv6Addr>> {
        let mut candidates = Vec::new();
        for ip in self
            .stun
            .get_stun_info()
            .public_ip
            .into_iter()
            .filter_map(|ip| ip.parse().ok())
        {
            if let IpAddr::V6(ip) = ip {
                self.push_ipv6_candidate(&mut candidates, ip).await;
            }
        }
        let interface_addrs = self.host.interface_addrs().await?;
        for ip in interface_addrs
            .interface_ipv6s
            .into_iter()
            .chain(interface_addrs.public_ipv6)
        {
            self.push_ipv6_candidate(&mut candidates, ip).await;
        }
        Ok(candidates)
    }

    async fn push_ipv6_candidate(&self, candidates: &mut Vec<Ipv6Addr>, ip: Ipv6Addr) {
        if candidates.len() < MAX_IPV6_HOLE_PUNCH_CONNECTOR_ADDRS
            && self.is_usable_public_ipv6(&ip).await
            && !candidates.contains(&ip)
        {
            candidates.push(ip);
        }
    }

    async fn is_usable_public_ipv6(&self, ip: &Ipv6Addr) -> bool {
        !self.peer_manager.is_easytier_managed_ipv6(ip).await
            && (self.options.testing
                || (!ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_unique_local()
                    && !ip.is_unicast_link_local()
                    && !ip.is_multicast()))
    }

    async fn remote_send_udp_hole_punch_packet(
        &self,
        dst_peer_id: PeerId,
        connector_addrs: Vec<SocketAddr>,
        preferred_src_ipv6: Option<Ipv6Addr>,
        remote_url: &Url,
    ) -> anyhow::Result<()> {
        if remote_url.scheme() != "udp" {
            anyhow::bail!("UDP punch request requires a UDP listener: {remote_url}");
        }
        let listener_port = mapped_listener_port(remote_url)
            .ok_or_else(|| anyhow::anyhow!("listener has no port: {remote_url}"))?;
        let rpc_stub = self
            .peer_manager
            .get_peer_rpc_mgr()
            .rpc_client()
            .scoped_client::<DirectConnectorRpcClientFactory<BaseController>>(
            self.peer_manager.my_peer_id(),
            dst_peer_id,
            self.peer_manager.network_name().to_owned(),
        );
        rpc_stub
            .send_udp_hole_punch_packet(
                BaseController::default(),
                SendUdpHolePunchPacketRequest {
                    connector_addr: connector_addrs.first().copied().map(Into::into),
                    listener_port: listener_port as u32,
                    preferred_src_ipv6: preferred_src_ipv6.map(Into::into),
                    connector_addrs: connector_addrs.into_iter().map(Into::into).collect(),
                },
            )
            .await
            .with_context(|| format!("send UDP punch request to peer {dst_peer_id}"))?;
        Ok(())
    }

    async fn admit(
        &self,
        tunnel: Box<dyn Tunnel>,
        dst_peer_id: PeerId,
    ) -> anyhow::Result<(PeerId, PeerConnId)> {
        self.peer_manager
            .add_client_tunnel_with_peer_id_hint(
                tunnel,
                PeerConnectionOrigin::Direct,
                Some(dst_peer_id),
            )
            .await
            .map_err(Into::into)
    }
}

pub(crate) struct DirectConnectorRpcHandler<H>
where
    H: DirectConnectorHost,
{
    host: Arc<H>,
    peer_manager: Option<Weak<PeerManagerCore>>,
    running_listeners: Arc<dyn LocalListenerUrls>,
    socket_context: SocketContext,
    foreign_network: bool,
    stun: Option<Arc<dyn StunInfoProvider>>,
    dns: Option<Arc<dyn DnsResolver>>,
}

impl<H> Clone for DirectConnectorRpcHandler<H>
where
    H: DirectConnectorHost,
{
    fn clone(&self) -> Self {
        Self {
            host: self.host.clone(),
            peer_manager: self.peer_manager.clone(),
            running_listeners: self.running_listeners.clone(),
            socket_context: self.socket_context.clone(),
            foreign_network: self.foreign_network,
            stun: self.stun.clone(),
            dns: self.dns.clone(),
        }
    }
}

impl<H> DirectConnectorRpcHandler<H>
where
    H: DirectConnectorHost,
{
    pub fn new_for_foreign_network_with_stun(
        host: Arc<H>,
        socket_context: SocketContext,
        stun: Option<Arc<dyn StunInfoProvider>>,
        running_listeners: Arc<dyn LocalListenerUrls>,
    ) -> Self {
        Self {
            host,
            peer_manager: None,
            running_listeners,
            socket_context,
            foreign_network: true,
            stun,
            dns: None,
        }
    }

    fn new_with_running_listeners_and_stun(
        host: Arc<H>,
        peer_manager: Option<Weak<PeerManagerCore>>,
        running_listeners: Arc<dyn LocalListenerUrls>,
        socket_context: SocketContext,
        stun: Option<Arc<dyn StunInfoProvider>>,
    ) -> Self {
        Self {
            host,
            peer_manager,
            running_listeners,
            socket_context,
            foreign_network: false,
            stun,
            dns: None,
        }
    }

    fn with_dns(mut self, dns: Arc<dyn DnsResolver>) -> Self {
        self.dns = Some(dns);
        self
    }
}

async fn collect_address_observations<H>(
    host: &H,
    peer_manager: Option<&PeerManagerCore>,
    socket_context: &SocketContext,
    foreign_network: bool,
    stun_info: Option<&crate::proto::common::StunInfo>,
) -> GetIpListResponse
where
    H: DirectConnectorHost,
{
    let mut response = if foreign_network {
        host.collect_foreign_ip_addrs(socket_context).await
    } else {
        host.collect_ip_addrs(socket_context).await
    };
    if let Some(stun_info) = stun_info {
        for public_ip in &stun_info.public_ip {
            match public_ip.parse::<IpAddr>() {
                Ok(IpAddr::V4(ip)) => response.public_ipv4 = Some(ip.into()),
                Ok(IpAddr::V6(ip)) => response.public_ipv6 = Some(ip.into()),
                Err(_) => {}
            }
        }
    }
    if let Some(peer_manager) = peer_manager.filter(|_| !foreign_network) {
        let mut interface_ipv6s = Vec::with_capacity(response.interface_ipv6s.len());
        for ip in response.interface_ipv6s {
            if !peer_manager
                .is_easytier_managed_ipv6(&Ipv6Addr::from(ip))
                .await
            {
                interface_ipv6s.push(ip);
            }
        }
        response.interface_ipv6s = interface_ipv6s;
        if let Some(ip) = response.public_ipv6.map(Ipv6Addr::from)
            && peer_manager.is_easytier_managed_ipv6(&ip).await
        {
            response.public_ipv6 = None;
        }
    }
    response
}

pub(crate) struct ForeignDirectConnectorRpcRegistrar<H>
where
    H: DirectConnectorHost,
{
    host: Arc<H>,
    stun: Arc<dyn StunInfoProvider>,
    running_listeners: Arc<dyn LocalListenerUrls>,
    dns: Option<Arc<dyn DnsResolver>>,
}

impl<H> ForeignDirectConnectorRpcRegistrar<H>
where
    H: DirectConnectorHost,
{
    pub fn new(
        host: Arc<H>,
        stun: Arc<dyn StunInfoProvider>,
        running_listeners: Arc<dyn LocalListenerUrls>,
    ) -> Self {
        Self {
            host,
            stun,
            running_listeners,
            dns: None,
        }
    }

    pub fn with_dns(mut self, dns: Arc<dyn DnsResolver>) -> Self {
        self.dns = Some(dns);
        self
    }
}

impl<H> ForeignNetworkRpcRegistrar for ForeignDirectConnectorRpcRegistrar<H>
where
    H: DirectConnectorHost,
{
    fn register_peer_rpc_services(
        &self,
        peer_rpc: &Arc<PeerRpcManager>,
        network_name: &str,
        socket_context: SocketContext,
    ) {
        let mut handler = DirectConnectorRpcHandler::new_for_foreign_network_with_stun(
            self.host.clone(),
            socket_context,
            Some(self.stun.clone()),
            self.running_listeners.clone(),
        );
        if let Some(dns) = &self.dns {
            handler = handler.with_dns(dns.clone());
        }
        peer_rpc.rpc_server().registry().register(
            GeneratedDirectConnectorRpcServer::new(handler),
            network_name,
        );
    }
}

#[async_trait]
impl<H> DirectConnectorRpc for DirectConnectorRpcHandler<H>
where
    H: DirectConnectorHost,
{
    type Controller = BaseController;

    async fn get_ip_list(
        &self,
        _: BaseController,
        _: GetIpListRequest,
    ) -> rpc_types::error::Result<GetIpListResponse> {
        let peer_manager = self.peer_manager.as_ref().and_then(Weak::upgrade);
        let mut response = collect_address_observations(
            self.host.as_ref(),
            peer_manager.as_deref(),
            &self.socket_context,
            self.foreign_network,
            self.stun
                .as_deref()
                .map(StunInfoProvider::get_stun_info)
                .as_ref(),
        )
        .await;
        response.listeners = self
            .host
            .mapped_listeners()
            .into_iter()
            .chain(
                self.running_listeners
                    .local_listener_urls()
                    .into_iter()
                    .filter(|_| !self.foreign_network),
            )
            .map(Into::into)
            .collect();
        Ok(response)
    }

    async fn send_udp_hole_punch_packet(
        &self,
        _: BaseController,
        request: SendUdpHolePunchPacketRequest,
    ) -> rpc_types::error::Result<Void> {
        let (listener_port, connector_addrs, preferred_src_ipv6) =
            connector_addrs_from_request(request)?;
        let family = if connector_addrs[0].is_ipv6() {
            IpVersion::V6
        } else {
            IpVersion::V4
        };
        let listener_ports = udp_hole_punch_listener_ports_with_dns(
            listener_port,
            family,
            self.running_listeners.as_ref(),
            || self.host.mapped_listeners(),
            self.socket_context.clone(),
            self.dns.as_deref(),
        )
        .await?;
        let peer_manager = self.peer_manager.as_ref().and_then(Weak::upgrade);
        let preferred_source = match preferred_src_ipv6.map(Ipv6Addr::from) {
            Some(ip) => {
                if self.foreign_network {
                    self.host
                        .preferred_foreign_ipv6_source(ip, self.socket_context.clone())
                        .await
                } else if let Some(peer_manager) = peer_manager.as_deref()
                    && peer_manager.is_easytier_managed_ipv6(&ip).await
                {
                    None
                } else {
                    self.host
                        .preferred_ipv6_source(ip, self.socket_context.clone())
                        .await
                }
            }
            None => None,
        };

        for _ in 0..3 {
            for listener_port in &listener_ports {
                for connector_addr in &connector_addrs {
                    let result = match connector_addr {
                        SocketAddr::V4(addr) => {
                            send_v4_hole_punch_control_packet(
                                self.host.as_ref(),
                                self.socket_context.clone(),
                                *listener_port,
                                *addr,
                            )
                            .await
                        }
                        SocketAddr::V6(addr) => {
                            send_v6_hole_punch_control_packet(
                                self.host.as_ref(),
                                self.socket_context.clone(),
                                *listener_port,
                                *addr,
                                preferred_source,
                            )
                            .await
                        }
                    };
                    if let Err(error) = result {
                        tracing::debug!(
                            ?error,
                            ?connector_addr,
                            listener_port,
                            "send UDP punch packet failed"
                        );
                    }
                }
            }
            crate::foundation::time::sleep(Duration::from_millis(30)).await;
        }
        Ok(Void::default())
    }
}

fn same_family_udp_listener(url: &Url, family: IpVersion) -> bool {
    url.scheme() == "udp"
        && matches!(
            (literal_url_ip(url), family),
            (Some(IpAddr::V4(_)), IpVersion::V4) | (Some(IpAddr::V6(_)), IpVersion::V6)
        )
}

fn actual_udp_listener_ports(running_listeners: &[Url], family: IpVersion) -> BTreeSet<u16> {
    running_listeners
        .iter()
        .filter(|url| same_family_udp_listener(url, family))
        .filter_map(mapped_listener_port)
        .filter(|port| *port != 0)
        .collect()
}

async fn udp_hole_punch_listener_ports_with_dns<F>(
    requested_port: u16,
    family: IpVersion,
    running_listeners: &dyn LocalListenerUrls,
    mapped_listeners: F,
    context: SocketContext,
    dns: Option<&dyn DnsResolver>,
) -> anyhow::Result<Vec<u16>>
where
    F: Fn() -> Vec<Url> + Send + Sync,
{
    let running = running_listeners.udp_control_listener_urls();
    let mapped = mapped_listeners();
    let initial_error =
        match udp_hole_punch_listener_ports(requested_port, family, &running, &mapped) {
            Ok(ports) => return Ok(ports),
            Err(error) => error,
        };
    // DNS may identify the family of an administrator's alias, but cannot
    // create a socket owner or authorize a port absent from configuration.
    let actual_ports = actual_udp_listener_ports(&running, family);
    if actual_ports.is_empty() || actual_ports.len() > MAX_UDP_HOLE_PUNCH_LISTENER_PORTS {
        return Err(initial_error);
    }
    let aliases = mapped
        .into_iter()
        .filter(|url| {
            url.scheme() == "udp"
                && requested_port != 0
                && mapped_listener_port(url) == Some(requested_port)
                && literal_url_ip(url).is_none()
                && matches!(url.host(), Some(Host::Domain(_)))
        })
        .collect::<Vec<_>>();
    let Some(dns) = dns.filter(|_| !aliases.is_empty()) else {
        return Err(initial_error);
    };
    crate::foundation::time::timeout(UDP_MAPPED_LISTENER_DNS_TIMEOUT, async {
        let mut resolutions = futures::stream::iter(aliases)
            .map(|alias| {
                let context = context.clone().with_ip_version(family);
                let mapped_listeners = &mapped_listeners;
                async move {
                    let current_ports = actual_udp_listener_ports(
                        &running_listeners.udp_control_listener_urls(),
                        family,
                    );
                    if current_ports.is_empty()
                        || current_ports.len() > MAX_UDP_HOLE_PUNCH_LISTENER_PORTS
                        || !mapped_listeners().contains(&alias)
                    {
                        return None;
                    }
                    let addrs = resolve_url_addrs(&alias, requested_port, context, dns).await;
                    Some((alias, addrs))
                }
            })
            .buffer_unordered(MAX_UDP_MAPPED_LISTENER_DNS_QUERIES);
        while let Some(resolution) = resolutions.next().await {
            let current_ports =
                actual_udp_listener_ports(&running_listeners.udp_control_listener_urls(), family);
            if current_ports.is_empty() || current_ports.len() > MAX_UDP_HOLE_PUNCH_LISTENER_PORTS {
                return Err(initial_error);
            }
            let Some((alias, Ok(addrs))) = resolution else {
                continue;
            };
            let mut literals = Vec::new();
            for addr in addrs {
                if matches!(addr.ip(), IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some()) {
                    continue;
                }
                let mut literal = alias.clone();
                literal
                    .set_ip_host(addr.ip())
                    .expect("IP is a valid URL host");
                if same_family_udp_listener(&literal, family) {
                    literals.push(literal);
                }
            }
            if literals.is_empty() {
                continue;
            }
            // Both the socket owner and its alias may disappear during DNS.
            // A valid alias suffices; do not wait for unrelated slower aliases.
            let mut current_mapped = mapped_listeners();
            if !current_mapped.contains(&alias) {
                continue;
            }
            current_mapped.extend(literals);
            return udp_hole_punch_listener_ports(
                requested_port,
                family,
                &running_listeners.udp_control_listener_urls(),
                &current_mapped,
            );
        }
        Err(initial_error)
    })
    .await
    .map_err(|_| anyhow::anyhow!("configured UDP mapped listener DNS resolution timed out"))?
}

fn udp_hole_punch_listener_ports(
    requested_port: u16,
    family: IpVersion,
    running_listeners: &[Url],
    mapped_listeners: &[Url],
) -> anyhow::Result<Vec<u16>> {
    anyhow::ensure!(
        requested_port != 0,
        "UDP punch listener port must be nonzero"
    );
    let actual_ports = actual_udp_listener_ports(running_listeners, family);
    if actual_ports.contains(&requested_port) {
        return Ok(vec![requested_port]);
    }
    anyhow::ensure!(
        mapped_listeners.iter().any(|url| {
            same_family_udp_listener(url, family)
                && mapped_listener_port(url) == Some(requested_port)
        }),
        "UDP punch port {requested_port} is not a known {family:?} listener or mapped advertisement"
    );
    anyhow::ensure!(
        !actual_ports.is_empty(),
        "mapped UDP advertisement has no running {family:?} listener"
    );
    anyhow::ensure!(
        actual_ports.len() <= MAX_UDP_HOLE_PUNCH_LISTENER_PORTS,
        "mapped UDP advertisement has too many possible local listeners: {}",
        actual_ports.len()
    );
    Ok(actual_ports.into_iter().collect())
}

#[cfg(feature = "test-utils")]
pub async fn send_udp_hole_punch_packet_for_test<H>(
    host: Arc<H>,
    running_listeners: Vec<Url>,
    socket_context: SocketContext,
    request: SendUdpHolePunchPacketRequest,
    foreign_network: bool,
) -> rpc_types::error::Result<Void>
where
    H: DirectConnectorHost,
{
    send_udp_hole_punch_packet_with_dns_for_test(
        host,
        running_listeners,
        socket_context,
        request,
        foreign_network,
        None,
    )
    .await
}

#[cfg(feature = "test-utils")]
pub async fn send_udp_hole_punch_packet_with_dns_for_test<H>(
    host: Arc<H>,
    running_listeners: Vec<Url>,
    socket_context: SocketContext,
    request: SendUdpHolePunchPacketRequest,
    foreign_network: bool,
    dns: Option<Arc<dyn DnsResolver>>,
) -> rpc_types::error::Result<Void>
where
    H: DirectConnectorHost,
{
    #[derive(Debug)]
    struct TestListeners(Vec<Url>);
    impl LocalListenerUrls for TestListeners {
        fn local_listener_urls(&self) -> Vec<Url> {
            self.0.clone()
        }
    }
    let listeners = Arc::new(TestListeners(running_listeners));
    let mut handler = if foreign_network {
        DirectConnectorRpcHandler::new_for_foreign_network_with_stun(
            host,
            socket_context,
            None,
            listeners,
        )
    } else {
        DirectConnectorRpcHandler::new_with_running_listeners_and_stun(
            host,
            None,
            listeners,
            socket_context,
            None,
        )
    };
    if let Some(dns) = dns {
        handler = handler.with_dns(dns);
    }
    handler
        .send_udp_hole_punch_packet(BaseController::default(), request)
        .await
}

fn connector_addrs_from_request(
    request: SendUdpHolePunchPacketRequest,
) -> rpc_types::error::Result<(u16, Vec<SocketAddr>, Option<crate::proto::common::Ipv6Addr>)> {
    let listener_port = u16::try_from(request.listener_port)
        .map_err(|_| anyhow::anyhow!("listener_port out of range: {}", request.listener_port))?;
    let mut connector_addrs = request
        .connector_addrs
        .into_iter()
        .map(SocketAddr::from)
        .collect::<Vec<_>>();
    if connector_addrs.is_empty() {
        connector_addrs.push(
            request
                .connector_addr
                .ok_or_else(|| anyhow::anyhow!("connector_addr is required"))?
                .into(),
        );
    }
    let use_ipv6 = connector_addrs[0].is_ipv6();
    if connector_addrs
        .iter()
        .any(|addr| addr.is_ipv6() != use_ipv6)
    {
        return Err(
            anyhow::anyhow!("UDP punch connector addresses must use one address family").into(),
        );
    }
    let mut deduped = Vec::with_capacity(connector_addrs.len());
    for addr in connector_addrs {
        if !deduped.contains(&addr) {
            deduped.push(addr);
        }
        if deduped.len() >= MAX_UDP_HOLE_PUNCH_CONNECTOR_ADDRS {
            break;
        }
    }
    Ok((listener_port, deduped, request.preferred_src_ipv6))
}

fn mapped_listener_port(url: &Url) -> Option<u16> {
    url.port()
        .or_else(|| crate::connectivity::protocol::protocol_default_port(url.scheme()))
}

async fn resolve_mapped_listener_addrs(
    listener: &Url,
    context: SocketContext,
    dns: &dyn DnsResolver,
) -> anyhow::Result<Vec<SocketAddr>> {
    let port = mapped_listener_port(listener)
        .ok_or_else(|| anyhow::anyhow!("listener has no default port: {listener}"))?;
    resolve_url_addrs(
        listener,
        port,
        context.with_ip_version(IpVersion::Both),
        dns,
    )
    .await
}

fn resolve_literal_url(url: &Url, ip_version: IpVersion) -> anyhow::Result<SocketAddr> {
    let port =
        mapped_listener_port(url).ok_or_else(|| anyhow::anyhow!("listener has no port: {url}"))?;
    match (literal_url_ip(url), ip_version) {
        (Some(ip @ IpAddr::V4(_)), IpVersion::V4 | IpVersion::Both)
        | (Some(ip @ IpAddr::V6(_)), IpVersion::V6 | IpVersion::Both) => {
            Ok(SocketAddr::new(ip, port))
        }
        _ => anyhow::bail!("URL host does not match {ip_version:?}: {url}"),
    }
}

fn literal_url_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        // Non-special schemes retain IPv4 literals as Domain hosts.
        Host::Domain(host) => host.parse::<Ipv4Addr>().ok().map(IpAddr::V4),
    }
}

fn public_udp_punch_family(url: &Url) -> Option<IpVersion> {
    if url.scheme() != "udp" {
        return None;
    }
    match literal_url_ip(url) {
        Some(IpAddr::V4(ip)) if is_public_ipv4(ip) => Some(IpVersion::V4),
        Some(IpAddr::V6(_)) => Some(IpVersion::V6),
        _ => None,
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_broadcast()
        && !ip.is_unspecified()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectivity::NoLocalListeners;

    #[test]
    fn ipv6_preference_is_opt_in() {
        assert!(!DirectConnectorOptions::default().prefer_ipv6);
    }

    #[test]
    fn ipv6_disconnect_cools_only_that_peer_without_delaying_total_reconnection() {
        let state = Ipv6UpgradeState::default();
        assert!(!state.should_attempt(7, true, true));
        assert!(
            !state.should_attempt(7, false, true),
            "keep IPv4 stable after IPv6 closes"
        );
        assert!(!state.should_attempt(7, false, true));
        assert!(
            state.should_attempt(8, false, true),
            "another peer has independent preference"
        );
        assert!(
            state.should_attempt(7, false, false),
            "both paths gone must reconnect immediately"
        );
    }

    #[test]
    fn failed_ipv6_upgrade_is_cooled_while_ipv4_remains_available() {
        let state = Ipv6UpgradeState::default();
        state.completed(9, false, true);
        assert!(!state.should_attempt(9, false, true));
        assert!(state.should_attempt(9, false, false));
        state.completed(10, false, false);
        assert!(state.should_attempt(10, false, false));
    }

    #[tokio::test]
    async fn ipv6_udp_punch_uses_full_mapping_before_native_candidates() {
        let mapped = "[2001:db8::7]:2862".parse::<SocketAddrV6>().unwrap();
        let native = "2001:db8::8".parse::<Ipv6Addr>().unwrap();
        let addrs = ipv6_udp_punch_addrs(40000, async { Ok(mapped) }, async {
            Ok(vec![*mapped.ip(), native])
        })
        .await;

        assert_eq!(
            addrs,
            vec![
                SocketAddr::V6(mapped),
                SocketAddr::new(native.into(), 40000)
            ]
        );
        assert!(!addrs.contains(&SocketAddr::new((*mapped.ip()).into(), 40000)));
    }

    #[tokio::test]
    async fn ipv6_udp_punch_without_stun_preserves_native_fallback() {
        let native = "2001:db8::8".parse::<Ipv6Addr>().unwrap();
        let addrs = ipv6_udp_punch_addrs(
            40000,
            async { anyhow::bail!("no IPv6 STUN servers") },
            async { Ok(vec![native]) },
        )
        .await;
        assert_eq!(addrs, vec![SocketAddr::new(native.into(), 40000)]);
    }

    #[tokio::test(start_paused = true)]
    async fn ipv6_udp_punch_mapping_timeout_keeps_fallback_bounded() {
        let native = "2001:db8::8".parse::<Ipv6Addr>().unwrap();
        let started = tokio::time::Instant::now();
        let addrs =
            ipv6_udp_punch_addrs(40000, std::future::pending(), async { Ok(vec![native]) }).await;
        assert_eq!(addrs, vec![SocketAddr::new(native.into(), 40000)]);
        assert_eq!(started.elapsed(), IPV6_PORT_MAPPING_TIMEOUT);
    }

    #[tokio::test]
    async fn ipv6_head_start_does_not_poll_ipv4_when_ipv6_succeeds() {
        let ipv4_polled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = ipv4_polled.clone();
        assert!(
            connect_with_ipv6_head_start(
                async { Ok(()) },
                async move {
                    observed.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
                Duration::ZERO,
            )
            .await
            .unwrap()
        );
        assert!(!ipv4_polled.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn ipv6_fast_failure_bypasses_fallback_delay() {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            connect_with_ipv6_head_start(
                async { anyhow::bail!("unreachable") },
                async { Ok(()) },
                Duration::from_secs(60),
            ),
        )
        .await
        .expect("IPv4 must not wait for the IPv6 head start after a hard failure")
        .unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn established_ipv4_is_retained_while_ipv6_upgrade_finishes() {
        let (allow_ipv6, wait_ipv6) = tokio::sync::oneshot::channel::<()>();
        let (ipv4_ready, wait_ipv4) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(connect_with_ipv6_head_start(
            async move {
                wait_ipv6.await.unwrap();
                Ok(())
            },
            async move {
                ipv4_ready.send(()).unwrap();
                Ok(())
            },
            Duration::ZERO,
        ));
        tokio::time::timeout(Duration::from_secs(1), wait_ipv4)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !task.is_finished(),
            "upgrade must remain eligible after IPv4 established"
        );
        allow_ipv6.send(()).unwrap();
        assert!(task.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn failed_ipv6_upgrade_does_not_discard_established_ipv4() {
        let (fail_ipv6, wait_ipv6) = tokio::sync::oneshot::channel::<()>();
        let (ipv4_ready, wait_ipv4) = tokio::sync::oneshot::channel::<()>();
        let task = tokio::spawn(connect_with_ipv6_head_start(
            async move {
                wait_ipv6.await.unwrap();
                anyhow::bail!("blackholed")
            },
            async move {
                ipv4_ready.send(()).unwrap();
                Ok(())
            },
            Duration::ZERO,
        ));
        wait_ipv4.await.unwrap();
        fail_ipv6.send(()).unwrap();
        assert!(!task.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn ipv6_failure_for_one_peer_does_not_change_another_peer() {
        let (dual_stack, ipv4_only) = tokio::join!(
            connect_with_ipv6_head_start(
                async { Ok(()) },
                async { anyhow::bail!("IPv4 not needed") },
                Duration::ZERO,
            ),
            connect_with_ipv6_head_start(
                async { anyhow::bail!("no IPv6 listener") },
                async { Ok(()) },
                Duration::ZERO,
            ),
        );
        assert!(dual_stack.unwrap());
        assert!(!ipv4_only.unwrap());
    }

    impl<H> DirectConnectorRpcHandler<H>
    where
        H: DirectConnectorHost,
    {
        pub(crate) fn new_with_stun(
            host: Arc<H>,
            socket_context: SocketContext,
            stun: Option<Arc<dyn StunInfoProvider>>,
        ) -> Self {
            let running_listeners = Arc::new(NoLocalListeners);
            Self {
                host,
                peer_manager: None,
                running_listeners,
                socket_context,
                foreign_network: false,
                stun,
                dns: None,
            }
        }
    }

    #[test]
    fn faketcp_uses_specialized_tcp_socket_without_interface_binding() {
        let transport =
            DirectTransport::from_url(&"faketcp://127.0.0.1:11013".parse().unwrap()).unwrap();

        assert_eq!(transport, DirectTransport::Tcp(TcpSocketPurpose::FakeTcp));
        assert!(!transport.supports_interface_bind());
        assert!(!transport.is_udp());
    }

    #[test]
    fn parsed_udp_literals_select_punch_without_treating_dns_as_literal() {
        for (raw_url, expected_family) in [
            ("udp://198.51.100.7:2862", Some(IpVersion::V4)),
            ("udp://[2001:db8::7]:2862", Some(IpVersion::V6)),
            ("udp://192.168.1.7:2862", None),
            ("udp://peer.example:2862", None),
            ("tcp://198.51.100.7:2862", None),
        ] {
            // Use the same parse after serialization as connect_to_url_once.
            let url = Url::parse(raw_url).unwrap();
            assert_eq!(public_udp_punch_family(&url), expected_family, "{raw_url}");
        }
        let v4 = Url::parse("udp://198.51.100.7:2862").unwrap();
        assert!(matches!(v4.host(), Some(Host::Domain(_))));
        assert_eq!(
            resolve_literal_url(&v4, IpVersion::V4).unwrap(),
            "198.51.100.7:2862".parse().unwrap()
        );
        assert!(resolve_literal_url(&v4, IpVersion::V6).is_err());
        let v6 = Url::parse("udp://[2001:db8::7]:2862").unwrap();
        assert_eq!(
            resolve_literal_url(&v6, IpVersion::V6).unwrap(),
            "[2001:db8::7]:2862".parse().unwrap()
        );
        assert!(resolve_literal_url(&v6, IpVersion::V4).is_err());
        let dns = Url::parse("udp://peer.example:2862").unwrap();
        assert_eq!(literal_url_ip(&dns), None);
        assert!(resolve_literal_url(&dns, IpVersion::Both).is_err());
    }

    #[test]
    fn udp_punch_mapped_port_selects_actual_listener_in_each_family() {
        for (family, local, wrong_family, mapped) in [
            (
                IpVersion::V4,
                "udp://0.0.0.0:40000",
                "udp://[::]:2862",
                "udp://198.51.100.7:2862",
            ),
            (
                IpVersion::V6,
                "udp://[::]:40000",
                "udp://0.0.0.0:2862",
                "udp://[2001:db8::7]:2862",
            ),
        ] {
            let ports = udp_hole_punch_listener_ports(
                2862,
                family,
                &[local.parse().unwrap(), wrong_family.parse().unwrap()],
                &[mapped.parse().unwrap()],
            )
            .unwrap();
            assert_eq!(ports, vec![40000]);
        }
    }

    #[test]
    fn udp_punch_exact_local_port_takes_precedence_over_mapped_candidates() {
        let listeners = ["udp://[::]:40000", "udp://[::]:40001"].map(|url| url.parse().unwrap());
        assert_eq!(
            udp_hole_punch_listener_ports(40000, IpVersion::V6, &listeners, &[]).unwrap(),
            vec![40000]
        );
    }

    #[test]
    fn udp_punch_rejects_unknown_and_ambiguous_advertisements() {
        let running = ["udp://[::]:40000".parse().unwrap()];
        for mapped in [
            Vec::new(),
            vec!["udp://[2001:db8::7]:2863".parse().unwrap()],
            vec!["udp://198.51.100.7:2862".parse().unwrap()],
            vec!["tcp://[2001:db8::7]:2862".parse().unwrap()],
            vec!["udp://mapped.example:2862".parse().unwrap()],
        ] {
            assert!(udp_hole_punch_listener_ports(2862, IpVersion::V6, &running, &mapped).is_err());
        }
        assert!(
            udp_hole_punch_listener_ports(
                2862,
                IpVersion::V6,
                &[],
                &["udp://[2001:db8::7]:2862".parse().unwrap()]
            )
            .is_err()
        );
    }

    #[test]
    fn udp_punch_mapped_candidates_are_deduplicated_and_bounded_without_truncation() {
        let mapped = ["udp://[2001:db8::7]:2862".parse().unwrap()];
        let mut running = (40000..40016)
            .map(|port| format!("udp://[::]:{port}").parse().unwrap())
            .collect::<Vec<_>>();
        running.push("udp://[::1]:40000".parse().unwrap());
        let ports = udp_hole_punch_listener_ports(2862, IpVersion::V6, &running, &mapped).unwrap();
        assert_eq!(ports, (40000..40016).collect::<Vec<_>>());
        running.push("udp://[::]:40016".parse().unwrap());
        assert!(udp_hole_punch_listener_ports(2862, IpVersion::V6, &running, &mapped).is_err());
        assert_eq!(
            udp_hole_punch_listener_ports(40016, IpVersion::V6, &running, &mapped).unwrap(),
            vec![40016]
        );
    }

    #[derive(Debug, Default)]
    struct AliasTestListeners(std::sync::Mutex<Vec<Url>>);

    impl LocalListenerUrls for AliasTestListeners {
        fn local_listener_urls(&self) -> Vec<Url> {
            self.0.lock().unwrap().clone()
        }
    }

    #[derive(Default)]
    struct AliasTestDns {
        addrs: Vec<IpAddr>,
        fail: bool,
        queries: std::sync::Mutex<Vec<crate::host::dns::DnsQuery>>,
        entered: tokio::sync::Notify,
        release: Option<Arc<tokio::sync::Notify>>,
        pending_host: Option<String>,
    }

    #[async_trait]
    impl DnsResolver for AliasTestDns {
        async fn resolve(&self, query: crate::host::dns::DnsQuery) -> anyhow::Result<Vec<IpAddr>> {
            let pending = self.pending_host.as_deref() == Some(query.host.as_str());
            self.queries.lock().unwrap().push(query);
            self.entered.notify_one();
            if pending {
                return std::future::pending().await;
            }
            if let Some(release) = &self.release {
                release.notified().await;
            }
            anyhow::ensure!(!self.fail, "injected DNS failure");
            Ok(self.addrs.clone())
        }
    }

    #[tokio::test]
    async fn udp_punch_fqdn_uses_requested_family_and_returns_before_slow_alias() {
        for (family, expected_port) in [(IpVersion::V4, 40000), (IpVersion::V6, 40001)] {
            let running = AliasTestListeners(std::sync::Mutex::new(
                ["udp://0.0.0.0:40000", "udp://[::]:40001"]
                    .map(|url| url.parse().unwrap())
                    .to_vec(),
            ));
            let mapped = [
                "tcp://ignored.example:2862",
                "udp://other-port.example:2863",
                "udp://gw.example:2862",
                "udp://slow.example:2862",
            ]
            .map(|url| url.parse().unwrap())
            .to_vec();
            let dns = AliasTestDns {
                addrs: ["198.51.100.7", "2001:db8::7"]
                    .map(|ip| ip.parse().unwrap())
                    .to_vec(),
                pending_host: Some("slow.example".to_owned()),
                ..Default::default()
            };
            let context = SocketContext::default()
                .with_socket_mark(Some(19))
                .with_netns(Some(crate::socket::NetNamespace::new("alias-test")));
            assert_eq!(
                udp_hole_punch_listener_ports_with_dns(
                    2862,
                    family,
                    &running,
                    || mapped.clone(),
                    context.clone(),
                    Some(&dns),
                )
                .await
                .unwrap(),
                vec![expected_port],
            );
            let queries = dns.queries.lock().unwrap();
            assert!(queries.iter().any(|query| query.host == "gw.example"));
            assert!(queries.iter().all(|query| {
                ["gw.example", "slow.example"].contains(&query.host.as_str())
                    && query.context == context.clone().with_ip_version(family)
            }));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn udp_punch_fqdn_slow_first_alias_does_not_block_valid_second() {
        let running = AliasTestListeners(std::sync::Mutex::new(vec![
            "udp://[::]:40000".parse().unwrap(),
        ]));
        let mapped = ["udp://slow.example:2862", "udp://gw.example:2862"]
            .map(|url| url.parse().unwrap())
            .to_vec();
        let dns = AliasTestDns {
            addrs: vec!["2001:db8::7".parse().unwrap()],
            pending_host: Some("slow.example".to_owned()),
            ..Default::default()
        };
        let started = tokio::time::Instant::now();
        assert_eq!(
            udp_hole_punch_listener_ports_with_dns(
                2862,
                IpVersion::V6,
                &running,
                || mapped.clone(),
                SocketContext::default(),
                Some(&dns),
            )
            .await
            .unwrap(),
            vec![40000]
        );
        assert_eq!(started.elapsed(), Duration::ZERO);
        let queries = dns.queries.lock().unwrap();
        assert!(queries.iter().any(|query| query.host == "slow.example"));
        assert!(queries.iter().any(|query| query.host == "gw.example"));
    }

    #[tokio::test(start_paused = true)]
    async fn udp_punch_fqdn_queries_have_bounded_concurrency() {
        let running = AliasTestListeners(std::sync::Mutex::new(vec![
            "udp://[::]:40000".parse().unwrap(),
        ]));
        let mapped = (0..MAX_UDP_MAPPED_LISTENER_DNS_QUERIES + 2)
            .map(|index| format!("udp://gw{index}.example:2862").parse().unwrap())
            .collect::<Vec<_>>();
        let dns = AliasTestDns {
            release: Some(Arc::new(tokio::sync::Notify::new())),
            ..Default::default()
        };
        assert!(
            udp_hole_punch_listener_ports_with_dns(
                2862,
                IpVersion::V6,
                &running,
                || mapped.clone(),
                SocketContext::default(),
                Some(&dns),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("timed out")
        );
        assert_eq!(
            dns.queries.lock().unwrap().len(),
            MAX_UDP_MAPPED_LISTENER_DNS_QUERIES
        );
    }

    #[tokio::test]
    async fn udp_punch_fqdn_skips_dns_for_exact_literal_unknown_and_missing_owners() {
        let alias: Url = "udp://gw.example:2862".parse().unwrap();
        let local: Url = "udp://[::]:40000".parse().unwrap();
        for (requested, running, mapped, succeeds) in [
            (40000, vec![local.clone()], vec![alias.clone()], true),
            (
                2862,
                vec![local.clone()],
                vec!["udp://[2001:db8::7]:2862".parse().unwrap()],
                true,
            ),
            (2863, vec![local.clone()], vec![alias.clone()], false),
            (2862, vec![], vec![alias.clone()], false),
            (
                2862,
                vec!["udp://0.0.0.0:40000".parse().unwrap()],
                vec![alias.clone()],
                false,
            ),
            (
                2862,
                vec![local.clone()],
                vec!["tcp://gw.example:2862".parse().unwrap()],
                false,
            ),
            (
                2862,
                (40000..40017)
                    .map(|port| format!("udp://[::]:{port}").parse().unwrap())
                    .collect(),
                vec![alias],
                false,
            ),
        ] {
            let dns = AliasTestDns::default();
            let running = AliasTestListeners(std::sync::Mutex::new(running));
            assert_eq!(
                udp_hole_punch_listener_ports_with_dns(
                    requested,
                    IpVersion::V6,
                    &running,
                    || mapped.clone(),
                    SocketContext::default(),
                    Some(&dns),
                )
                .await
                .is_ok(),
                succeeds,
            );
            assert!(dns.queries.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn udp_punch_fqdn_rejects_dns_errors_and_missing_actual_family() {
        let running = AliasTestListeners(std::sync::Mutex::new(vec![
            "udp://[::]:40000".parse().unwrap(),
        ]));
        let mapped = vec!["udp://gw.example:2862".parse().unwrap()];
        for (addrs, fail) in [
            (Vec::new(), false),
            (vec!["198.51.100.7".parse().unwrap()], false),
            (vec!["::ffff:198.51.100.7".parse().unwrap()], false),
            (vec!["2001:db8::7".parse().unwrap()], true),
        ] {
            let dns = AliasTestDns {
                addrs,
                fail,
                ..Default::default()
            };
            assert!(
                udp_hole_punch_listener_ports_with_dns(
                    2862,
                    IpVersion::V6,
                    &running,
                    || mapped.clone(),
                    SocketContext::default(),
                    Some(&dns),
                )
                .await
                .is_err()
            );
            assert_eq!(dns.queries.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn udp_punch_fqdn_rechecks_owner_and_mapping_after_dns() {
        for revoke_owner in [true, false] {
            let running = Arc::new(AliasTestListeners(std::sync::Mutex::new(vec![
                "udp://[::]:40000".parse().unwrap(),
            ])));
            let mapped = Arc::new(std::sync::Mutex::new(vec![
                "udp://gw.example:2862".parse().unwrap(),
            ]));
            let release = Arc::new(tokio::sync::Notify::new());
            let dns = Arc::new(AliasTestDns {
                addrs: vec!["2001:db8::7".parse().unwrap()],
                release: Some(release.clone()),
                ..Default::default()
            });
            let lookup = {
                let (running, mapped, dns) = (running.clone(), mapped.clone(), dns.clone());
                tokio::spawn(async move {
                    udp_hole_punch_listener_ports_with_dns(
                        2862,
                        IpVersion::V6,
                        running.as_ref(),
                        || mapped.lock().unwrap().clone(),
                        SocketContext::default(),
                        Some(dns.as_ref()),
                    )
                    .await
                })
            };
            dns.entered.notified().await;
            if revoke_owner {
                running.0.lock().unwrap().clear();
            } else {
                mapped.lock().unwrap().clear();
            }
            release.notify_one();
            assert!(lookup.await.unwrap().is_err());
        }
    }

    #[tokio::test(start_paused = true)]
    async fn udp_punch_fqdn_dns_has_one_bounded_budget() {
        let running = AliasTestListeners(std::sync::Mutex::new(vec![
            "udp://[::]:40000".parse().unwrap(),
        ]));
        let mapped = vec!["udp://gw.example:2862".parse().unwrap()];
        let dns = AliasTestDns {
            pending_host: Some("gw.example".to_owned()),
            ..Default::default()
        };
        let started = tokio::time::Instant::now();
        let result = udp_hole_punch_listener_ports_with_dns(
            2862,
            IpVersion::V6,
            &running,
            || mapped.clone(),
            SocketContext::default(),
            Some(&dns),
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert_eq!(started.elapsed(), UDP_MAPPED_LISTENER_DNS_TIMEOUT);
        assert_eq!(dns.queries.lock().unwrap().len(), 1);
    }

    #[test]
    fn udp_punch_request_rejects_mixed_families_before_address_cap() {
        let mut request = SendUdpHolePunchPacketRequest {
            listener_port: 40000,
            connector_addrs: (1..=MAX_UDP_HOLE_PUNCH_CONNECTOR_ADDRS)
                .map(|port| SocketAddr::from(([127, 0, 0, 1], port as u16)).into())
                .collect(),
            ..Default::default()
        };
        request
            .connector_addrs
            .push("[2001:db8::7]:40000".parse::<SocketAddr>().unwrap().into());
        assert!(connector_addrs_from_request(request).is_err());
    }

    #[test]
    fn connector_address_request_deduplicates_and_caps() {
        let mut request = SendUdpHolePunchPacketRequest {
            listener_port: 11010,
            ..Default::default()
        };
        for port in 1..=20 {
            request
                .connector_addrs
                .push(SocketAddr::from(([127, 0, 0, 1], port)).into());
        }
        request
            .connector_addrs
            .push(SocketAddr::from(([127, 0, 0, 1], 1)).into());

        let (_, addrs, _) = connector_addrs_from_request(request).unwrap();
        assert_eq!(addrs.len(), MAX_UDP_HOLE_PUNCH_CONNECTOR_ADDRS);
        assert_eq!(addrs[0], SocketAddr::from(([127, 0, 0, 1], 1)));
    }

    #[test]
    fn expiring_set_removes_expired_entries() {
        let set = ExpiringSet::default();
        set.insert(7u32, Duration::ZERO);
        assert!(!set.contains(&7));
    }
}
