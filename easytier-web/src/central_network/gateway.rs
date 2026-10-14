//! Applies Gateway-mode central-network intents to native runtimes.
//!
//! Runtime ownership follows the immutable central-network ID. Mesh names are
//! only a secondary lookup used by the shared config-server listener.

pub mod listener;
pub mod shared_udp;

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use base64::Engine as _;
use easytier::{
    common::config::{ConfigLoader as _, NetworkIdentity, TomlConfigLoader},
    instance::factory::{NativeCoreInstance, create_native_instance},
    tunnel::IpScheme,
};
use easytier_core::{
    config::toml::ManagedCredentialConfig,
    peers::{error::Error as PeerError, peer_manager::PeerManagerCore},
    tunnel::Tunnel,
};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::central_network::model::{CentralNetworkIntent, NetworkMode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayConfig {
    pub peer_url: String,
    pub relay_data: bool,
}

impl GatewayConfig {
    pub fn validate(&self, listener_protocol: &str) -> anyhow::Result<()> {
        let peer_url: url::Url = self
            .peer_url
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid gateway peer URL: {error}"))?;
        let listener_protocol = listener_protocol.to_ascii_lowercase();
        let listener_scheme: IpScheme = listener_protocol.parse().map_err(|_| {
            anyhow::anyhow!("unsupported config server protocol: {listener_protocol}")
        })?;
        if !matches!(
            listener_scheme,
            IpScheme::Tcp | IpScheme::Udp | IpScheme::Ws
        ) {
            anyhow::bail!("unsupported config server protocol: {listener_protocol}");
        }
        let scheme_matches = match listener_scheme {
            IpScheme::Ws => matches!(peer_url.scheme(), "ws" | "wss"),
            _ => peer_url.scheme() == listener_protocol,
        };
        if !scheme_matches {
            anyhow::bail!(
                "gateway peer URL scheme ({}) does not match config server protocol ({listener_protocol})",
                peer_url.scheme()
            );
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct GatewayRuntimeSpec {
    network_id: Uuid,
    user_id: i32,
    mesh_name: String,
    network_secret: String,
    secure_mode: bool,
    relay_data: bool,
    prefer_ipv6: bool,
    mapped_peer_url: Option<String>,
    credentials: Vec<ManagedCredentialConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct GatewayRuntimeKey {
    user_id: i32,
    network_id: Uuid,
}

impl GatewayRuntimeKey {
    fn from_intent(intent: &CentralNetworkIntent) -> Self {
        Self {
            user_id: intent.user_id,
            network_id: intent.id,
        }
    }
}

impl GatewayRuntimeSpec {
    fn from_intent(intent: &CentralNetworkIntent, relay_data: bool) -> Self {
        let mut credentials = intent
            .credentials
            .iter()
            .map(|credential| ManagedCredentialConfig {
                credential_id: credential.id.clone(),
                credential_secret: credential.secret.clone(),
                groups: credential.grant.acl_groups.clone(),
                allow_relay: credential.grant.allow_relay,
                allowed_proxy_cidrs: credential.grant.allowed_proxy_cidrs.clone(),
                expiry_unix: credential.expiry_unix,
                reusable: credential.grant.reusable,
            })
            .collect::<Vec<_>>();
        credentials.sort_by(|left, right| left.credential_id.cmp(&right.credential_id));
        Self {
            network_id: intent.id,
            user_id: intent.user_id,
            mesh_name: intent.network_name.clone(),
            network_secret: intent.network_secret.clone(),
            secure_mode: intent.secure_mode,
            relay_data,
            prefer_ipv6: intent.prefer_ipv6,
            mapped_peer_url: match &intent.mode {
                NetworkMode::Gateway { peer_url } => Some(peer_url.clone()),
                _ => None,
            },
            credentials,
        }
    }
}

#[async_trait]
pub(crate) trait GatewayRuntime: Send + Sync {
    async fn start(&self) -> anyhow::Result<()>;
    async fn stop(&self);
    async fn replace_credentials(
        &self,
        credentials: &[ManagedCredentialConfig],
    ) -> anyhow::Result<()>;
    fn peer_manager(&self) -> Option<Arc<PeerManagerCore>>;

    async fn observe_network(&self) -> Option<GatewayNetworkObservation> {
        let peer_manager = self.peer_manager()?;
        Some(observe_peer_manager(&peer_manager).await)
    }
}

pub(crate) trait GatewayRuntimeFactory: Send + Sync {
    fn build(&self, spec: &GatewayRuntimeSpec) -> anyhow::Result<Arc<dyn GatewayRuntime>>;
}

struct NativeGatewayRuntime(Arc<NativeCoreInstance>);

#[async_trait]
impl GatewayRuntime for NativeGatewayRuntime {
    async fn start(&self) -> anyhow::Result<()> {
        self.0.start().await
    }

    async fn stop(&self) {
        self.0.stop().await;
    }

    async fn replace_credentials(
        &self,
        credentials: &[ManagedCredentialConfig],
    ) -> anyhow::Result<()> {
        // The Core patch validates/reserves the complete set, commits its shared
        // TOML snapshot, installs it, then notifies existing authenticated peers.
        // This Gateway is reconstructed from durable central intent on restart.
        easytier_core::management::apply_config_patch(
            &self.0,
            easytier::proto::api::config::InstanceConfigPatch {
                managed_credentials: Some(easytier::proto::api::manage::ManagedCredentialSet {
                    entries: credentials
                        .iter()
                        .map(
                            |credential| easytier::proto::api::manage::ManagedCredentialConfig {
                                credential_id: credential.credential_id.clone(),
                                credential_secret: credential.credential_secret.clone(),
                                groups: credential.groups.clone(),
                                allow_relay: credential.allow_relay,
                                allowed_proxy_cidrs: credential.allowed_proxy_cidrs.clone(),
                                expiry_unix: credential.expiry_unix,
                                reusable: Some(credential.reusable),
                            },
                        )
                        .collect(),
                }),
                ..Default::default()
            },
            None,
        )
        .await
    }

    fn peer_manager(&self) -> Option<Arc<PeerManagerCore>> {
        Some(self.0.peer_manager().clone())
    }
}

#[derive(Default)]
struct NativeGatewayRuntimeFactory {
    shared_udp_control: Arc<shared_udp::SharedUdpControlEndpoints>,
}

impl GatewayRuntimeFactory for NativeGatewayRuntimeFactory {
    fn build(&self, spec: &GatewayRuntimeSpec) -> anyhow::Result<Arc<dyn GatewayRuntime>> {
        let config = TomlConfigLoader::default();
        #[cfg(test)]
        {
            // Native integration tests exercise only local transport ownership.
            config.set_stun_servers(Some(Vec::new()));
            config.set_stun_servers_v6(Some(Vec::new()));
        }
        config.set_inst_name(format!(
            "easytier-web-gw-{}-{}",
            spec.user_id, spec.network_id
        ));
        config.set_hostname(Some(hostname_or_default()));
        config.set_network_identity(NetworkIdentity::new(
            spec.mesh_name.clone(),
            spec.network_secret.clone(),
        ));
        config.set_dhcp(false);
        config.set_listeners(vec![]);
        // The listener is owned by Web and shared across central networks.
        // Advertise its public endpoint without binding a second socket, so
        // peers can discover and upgrade an existing IPv4 connection via IPv6.
        config.set_mapped_listeners(
            spec.mapped_peer_url
                .as_deref()
                .map(|url| url.parse().map(|url| vec![url]))
                .transpose()?,
        );

        let mut flags = config.get_flags();
        flags.no_tun = true;
        // The Gateway accepts through the Web's shared config listener and
        // owns no public socket to map. Never acquire host UPnP leases here.
        flags.disable_upnp = true;
        flags.disable_relay_data = !spec.relay_data;
        flags.bind_device = false;
        flags.prefer_ipv6 = spec.prefer_ipv6;
        config.set_flags(flags);

        if spec.secure_mode {
            let private = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
            let public = x25519_dalek::PublicKey::from(&private);
            config.set_secure_mode(Some(easytier::proto::common::SecureModeConfig {
                enabled: true,
                local_private_key: Some(
                    base64::engine::general_purpose::STANDARD.encode(private.as_bytes()),
                ),
                local_public_key: Some(
                    base64::engine::general_purpose::STANDARD.encode(public.as_bytes()),
                ),
            }));
        }
        config.set_managed_credentials(spec.credentials.clone());
        let instance = create_native_instance(config)?;
        instance.attach_shared_udp_control_source(self.shared_udp_control.clone());
        Ok(Arc::new(NativeGatewayRuntime(instance)))
    }
}

struct PublishedRuntime {
    spec: GatewayRuntimeSpec,
    runtime: Arc<dyn GatewayRuntime>,
    retiring: CancellationToken,
    admissions: Arc<RwLock<()>>,
}

#[derive(Default)]
struct State {
    by_key: HashMap<GatewayRuntimeKey, PublishedRuntime>,
    mesh_name_to_key: HashMap<String, GatewayRuntimeKey>,
    last_errors: HashMap<GatewayRuntimeKey, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GatewayDeploymentStatus {
    pub state: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct GatewayNetworkObservation {
    pub connections: Vec<easytier_proto::core_peer::peer::PeerConnInfo>,
    pub routes: Vec<easytier_proto::core_peer::peer::Route>,
}

pub struct NetworkInstanceManager {
    config: GatewayConfig,
    factory: Arc<dyn GatewayRuntimeFactory>,
    state: RwLock<State>,
    lifecycle: Mutex<()>,
}

impl std::fmt::Debug for NetworkInstanceManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NetworkInstanceManager")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl NetworkInstanceManager {
    pub fn new(config: GatewayConfig) -> Self {
        Self::with_shared_udp_control(
            config,
            Arc::new(shared_udp::SharedUdpControlEndpoints::default()),
        )
    }

    pub fn with_shared_udp_control(
        config: GatewayConfig,
        shared_udp_control: Arc<shared_udp::SharedUdpControlEndpoints>,
    ) -> Self {
        Self::with_factory(
            config,
            Arc::new(NativeGatewayRuntimeFactory { shared_udp_control }),
        )
    }

    pub(crate) fn with_factory(
        config: GatewayConfig,
        factory: Arc<dyn GatewayRuntimeFactory>,
    ) -> Self {
        Self {
            config,
            factory,
            state: RwLock::new(State::default()),
            lifecycle: Mutex::new(()),
        }
    }

    pub fn config(&self) -> &GatewayConfig {
        &self.config
    }

    pub async fn reconcile(&self, intent: &CentralNetworkIntent) {
        let _lifecycle = self.lifecycle.lock().await;
        self.reconcile_locked(intent).await;
    }

    async fn reconcile_locked(&self, intent: &CentralNetworkIntent) {
        let key = GatewayRuntimeKey::from_intent(intent);
        if !matches!(intent.mode, NetworkMode::Gateway { .. }) {
            self.remove_locked(key).await;
            return;
        }

        let spec = GatewayRuntimeSpec::from_intent(intent, self.config.relay_data);
        let existing = {
            let state = self.state.read().await;
            state
                .by_key
                .get(&key)
                .map(|published| (published.spec.clone(), published.runtime.clone()))
        };
        if let Some((current, runtime)) = &existing {
            if *current == spec {
                self.state.write().await.last_errors.remove(&key);
                return;
            }
            let mut current_identity = current.clone();
            current_identity.credentials.clear();
            let mut desired_identity = spec.clone();
            desired_identity.credentials.clear();
            if current_identity == desired_identity {
                match runtime.replace_credentials(&spec.credentials).await {
                    Ok(()) => {
                        let mut state = self.state.write().await;
                        if let Some(published) = state.by_key.get_mut(&key) {
                            published.spec = spec;
                        }
                        state.last_errors.remove(&key);
                    }
                    Err(error) => {
                        // Never stop an otherwise healthy mesh because a
                        // credential patch failed. The desired intent is kept
                        // and reconciliation retries it.
                        tracing::error!(user_id = key.user_id, network_id = %key.network_id,
                            "failed to hot-update Gateway credentials: {error:#}");
                        self.record_error(key, "Gateway credential update failed; retry pending")
                            .await;
                    }
                }
                return;
            }
        }

        let mesh_owner = self
            .state
            .read()
            .await
            .mesh_name_to_key
            .get(&spec.mesh_name)
            .copied();
        if mesh_owner.is_some_and(|owner| owner != key) {
            self.record_error(key, "Gateway mesh name is already owned")
                .await;
            return;
        }
        // This runtime has no listeners or TUN of its own. Build and start the
        // candidate before switching the shared listener's immutable ownership
        // index; failed replacements leave the old network usable.
        let candidate = match self.factory.build(&spec) {
            Ok(candidate) => candidate,
            Err(error) => {
                tracing::error!(user_id = key.user_id, network_id = %key.network_id,
                    "failed to build Gateway runtime: {error:#}");
                self.record_error(
                    key,
                    "Gateway runtime validation/build failed; previous runtime retained",
                )
                .await;
                return;
            }
        };
        if let Err(error) = candidate.start().await {
            candidate.stop().await;
            tracing::error!(user_id = key.user_id, network_id = %key.network_id,
                "failed to start Gateway runtime: {error:#}");
            self.record_error(
                key,
                "Gateway runtime startup failed; previous runtime retained",
            )
            .await;
            return;
        }
        let retired = {
            let mut state = self.state.write().await;
            let retired = state.by_key.remove(&key);
            if let Some(retired) = &retired
                && state.mesh_name_to_key.get(&retired.spec.mesh_name) == Some(&key)
            {
                state.mesh_name_to_key.remove(&retired.spec.mesh_name);
            }
            state.mesh_name_to_key.insert(spec.mesh_name.clone(), key);
            state.by_key.insert(
                key,
                PublishedRuntime {
                    spec,
                    runtime: candidate,
                    retiring: CancellationToken::new(),
                    admissions: Arc::new(RwLock::new(())),
                },
            );
            state.last_errors.remove(&key);
            retired
        };
        if let Some(retired) = retired {
            retired.retiring.cancel();
            let _admissions = retired.admissions.write().await;
            retired.runtime.stop().await;
        }
    }

    async fn record_error(&self, key: GatewayRuntimeKey, message: &str) {
        self.state
            .write()
            .await
            .last_errors
            .insert(key, message.to_owned());
    }

    pub async fn deployment_status(
        &self,
        user_id: i32,
        network_id: Uuid,
    ) -> GatewayDeploymentStatus {
        let key = GatewayRuntimeKey {
            user_id,
            network_id,
        };
        let state = self.state.read().await;
        let published = state.by_key.get(&key);
        let running = published.is_some();
        let peer_id = published
            .and_then(|published| published.runtime.peer_manager())
            .map(|manager| manager.my_peer_id());
        let peer_url = self.config.peer_url.parse::<url::Url>().ok().map(|url| {
            // Runtime diagnostics never need a credential-bearing path or
            // userinfo. The effective connector URL remains unchanged.
            easytier_core::connectivity::manual::redacted_endpoint_url(&url).to_string()
        });
        let last_error = state.last_errors.get(&key).cloned();
        GatewayDeploymentStatus {
            state: if last_error.is_some() {
                "failed"
            } else if running {
                "applied"
            } else {
                "pending"
            }
            .to_owned(),
            running,
            peer_id,
            peer_url,
            last_error,
        }
    }

    #[cfg(test)]
    pub(crate) async fn network_ids(&self) -> Vec<(i32, Uuid)> {
        self.state
            .read()
            .await
            .by_key
            .keys()
            .map(|key| (key.user_id, key.network_id))
            .collect()
    }

    pub(crate) async fn tracked_network_ids(&self) -> Vec<(i32, Uuid)> {
        let state = self.state.read().await;
        state
            .by_key
            .keys()
            .chain(state.last_errors.keys())
            .map(|key| (key.user_id, key.network_id))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub async fn remove(&self, user_id: i32, network_id: Uuid) {
        let _lifecycle = self.lifecycle.lock().await;
        self.remove_locked(GatewayRuntimeKey {
            user_id,
            network_id,
        })
        .await;
    }

    async fn remove_locked(&self, key: GatewayRuntimeKey) {
        let retired = {
            let mut state = self.state.write().await;
            let retired = state.by_key.remove(&key);
            state.last_errors.remove(&key);
            if let Some(retired) = retired.as_ref()
                && state.mesh_name_to_key.get(&retired.spec.mesh_name) == Some(&key)
            {
                state.mesh_name_to_key.remove(&retired.spec.mesh_name);
            }
            retired
        };
        if let Some(retired) = retired {
            retired.retiring.cancel();
            // Drain cancelled handshakes before stopping the runtime so none
            // can publish a connection after shutdown.
            let _admissions = retired.admissions.write().await;
            retired.runtime.stop().await;
        }
    }

    pub async fn accept_peer_tunnel(
        &self,
        mesh_name: &str,
        tunnel: Box<dyn Tunnel>,
    ) -> Option<Result<(), PeerError>> {
        let state = self.state.read().await;
        let key = state.mesh_name_to_key.get(mesh_name)?;
        let published = state.by_key.get(key)?;
        let peer_manager = published.runtime.peer_manager()?;
        let retiring = published.retiring.clone();
        let _admission = published.admissions.clone().read_owned().await;
        drop(state);
        tokio::select! {
            biased;
            _ = retiring.cancelled() => None,
            result = peer_manager.add_tunnel_as_server(tunnel) => Some(result),
        }
    }

    /// Snapshot a Gateway runtime only when both the tenant and immutable
    /// central-network ID match the published owner.
    pub(crate) async fn observe_network(
        &self,
        user_id: i32,
        network_id: Uuid,
    ) -> Option<GatewayNetworkObservation> {
        let key = GatewayRuntimeKey {
            user_id,
            network_id,
        };
        let runtime = {
            let state = self.state.read().await;
            let published = state.by_key.get(&key)?;
            published.runtime.clone()
        };
        runtime.observe_network().await
    }

    #[cfg(test)]
    pub(crate) async fn actual_mesh_name(&self, user_id: i32, network_id: Uuid) -> Option<String> {
        let key = GatewayRuntimeKey {
            user_id,
            network_id,
        };
        self.state
            .read()
            .await
            .by_key
            .get(&key)
            .map(|runtime| runtime.spec.mesh_name.clone())
    }

    #[cfg(test)]
    async fn runtime_ids(&self) -> Vec<Uuid> {
        let mut ids = self
            .state
            .read()
            .await
            .by_key
            .keys()
            .map(|key| key.network_id)
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    #[cfg(test)]
    async fn network_id_for_mesh(&self, mesh_name: &str) -> Option<Uuid> {
        self.state
            .read()
            .await
            .mesh_name_to_key
            .get(mesh_name)
            .map(|key| key.network_id)
    }
}

async fn observe_peer_manager(peer_manager: &PeerManagerCore) -> GatewayNetworkObservation {
    let mut observation = GatewayNetworkObservation::default();
    for peer in peer_manager.list_peer_snapshots().await {
        observation.connections.extend(peer.conns);
    }
    observation.routes = peer_manager.list_route_snapshots().await;
    observation
}

fn hostname_or_default() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|hostname| hostname.trim().to_owned())
        .filter(|hostname| !hostname.is_empty())
        .unwrap_or_else(|| "easytier-web-gateway".to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use uuid::Uuid;

    use crate::central_network::model::{
        CentralNetworkIntent, CredentialGrant, NetworkCredentialIntent, NetworkMode,
    };

    use super::*;

    #[derive(Default)]
    struct FakeFactory {
        built: Mutex<Vec<GatewayRuntimeSpec>>,
        fail_next: Mutex<bool>,
        fail_start_next: Mutex<bool>,
        stopped: Arc<Mutex<Vec<Uuid>>>,
        patched: Arc<Mutex<Vec<Vec<ManagedCredentialConfig>>>>,
        fail_patch: Arc<Mutex<bool>>,
    }

    struct FakeRuntime {
        id: Uuid,
        fail_start: bool,
        stopped: Arc<Mutex<Vec<Uuid>>>,
        patched: Arc<Mutex<Vec<Vec<ManagedCredentialConfig>>>>,
        fail_patch: Arc<Mutex<bool>>,
    }

    #[async_trait]
    impl GatewayRuntime for FakeRuntime {
        async fn start(&self) -> anyhow::Result<()> {
            if self.fail_start {
                anyhow::bail!("injected start failure");
            }
            Ok(())
        }

        async fn stop(&self) {
            self.stopped.lock().unwrap().push(self.id);
        }

        async fn replace_credentials(
            &self,
            credentials: &[ManagedCredentialConfig],
        ) -> anyhow::Result<()> {
            if std::mem::take(&mut *self.fail_patch.lock().unwrap()) {
                anyhow::bail!("injected credential patch failure");
            }
            self.patched.lock().unwrap().push(credentials.to_vec());
            Ok(())
        }

        fn peer_manager(&self) -> Option<Arc<easytier_core::peers::peer_manager::PeerManagerCore>> {
            None
        }

        async fn observe_network(&self) -> Option<GatewayNetworkObservation> {
            Some(GatewayNetworkObservation::default())
        }
    }

    impl GatewayRuntimeFactory for FakeFactory {
        fn build(&self, spec: &GatewayRuntimeSpec) -> anyhow::Result<Arc<dyn GatewayRuntime>> {
            self.built.lock().unwrap().push(spec.clone());
            if std::mem::take(&mut *self.fail_next.lock().unwrap()) {
                anyhow::bail!("injected build failure");
            }
            Ok(Arc::new(FakeRuntime {
                id: spec.network_id,
                fail_start: std::mem::take(&mut *self.fail_start_next.lock().unwrap()),
                stopped: self.stopped.clone(),
                patched: self.patched.clone(),
                fail_patch: self.fail_patch.clone(),
            }))
        }
    }

    fn gateway_intent(id: Uuid, mesh_name: &str) -> CentralNetworkIntent {
        CentralNetworkIntent {
            id,
            user_id: 7,
            display_name: mesh_name.to_owned(),
            network_name: mesh_name.to_owned(),
            network_secret: "secret".to_owned(),
            mode: NetworkMode::Gateway {
                peer_url: "tcp://gateway.example:22020".to_owned(),
            },
            virtual_cidr: None,
            secure_mode: false,
            prefer_ipv6: false,
            members: Vec::new(),
            credentials: Vec::new(),
            acl_policy: None,
        }
    }

    fn manager(factory: Arc<FakeFactory>) -> NetworkInstanceManager {
        NetworkInstanceManager::with_factory(
            GatewayConfig {
                peer_url: "tcp://gateway.example:22020".to_owned(),
                relay_data: false,
            },
            factory,
        )
    }

    #[tokio::test]
    async fn gateway_public_mapping_and_ipv6_preference_reach_runtime_factory() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let mut intent = gateway_intent(Uuid::new_v4(), "dual-stack-mapping");
        intent.prefer_ipv6 = true;
        intent.mode = NetworkMode::Gateway {
            peer_url: "tcp://vpn.qa.invalid:22020".to_owned(),
        };
        manager.reconcile(&intent).await;
        let built = factory.built.lock().unwrap();
        assert_eq!(built.len(), 1);
        assert!(built[0].prefer_ipv6);
        assert_eq!(
            built[0].mapped_peer_url.as_deref(),
            Some("tcp://vpn.qa.invalid:22020")
        );
        drop(built);
        assert!(
            manager
                .deployment_status(intent.user_id, intent.id)
                .await
                .running
        );
        manager.remove(intent.user_id, intent.id).await;
    }

    #[tokio::test]
    async fn changing_gateway_public_mapping_rebuilds_instead_of_patching_credentials() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let mut intent = gateway_intent(Uuid::new_v4(), "mapping-replacement");
        manager.reconcile(&intent).await;
        intent.mode = NetworkMode::Gateway {
            peer_url: "tcp://vpn.qa.invalid:22020".to_owned(),
        };
        manager.reconcile(&intent).await;
        let built = factory.built.lock().unwrap();
        assert_eq!(built.len(), 2);
        assert_eq!(
            built[0].mapped_peer_url.as_deref(),
            Some("tcp://gateway.example:22020")
        );
        assert_eq!(
            built[1].mapped_peer_url.as_deref(),
            Some("tcp://vpn.qa.invalid:22020")
        );
        drop(built);
        assert_eq!(*factory.stopped.lock().unwrap(), vec![intent.id]);
        assert!(factory.patched.lock().unwrap().is_empty());
        assert!(
            manager
                .deployment_status(intent.user_id, intent.id)
                .await
                .running
        );
        manager.remove(intent.user_id, intent.id).await;
    }

    #[tokio::test]
    async fn stalled_admission_does_not_block_reconcile_and_is_cancelled_on_removal() {
        use easytier_core::tunnel::ring::create_ring_tunnel_pair;
        use std::time::Duration;
        let manager = Arc::new(NetworkInstanceManager::new(GatewayConfig {
            peer_url: "tcp://localhost:22020".into(),
            relay_data: true,
        }));
        let intent = gateway_intent(Uuid::new_v4(), "stalled-admission");
        manager.reconcile(&intent).await;
        let (server, _client) = create_ring_tunnel_pair();
        let accepting = {
            let manager = manager.clone();
            tokio::spawn(async move {
                manager
                    .accept_peer_tunnel("stalled-admission", server)
                    .await
            })
        };
        // Wait until the real peer handshake holds the runtime admission lease.
        let admissions = manager
            .state
            .read()
            .await
            .by_key
            .get(&GatewayRuntimeKey::from_intent(&intent))
            .unwrap()
            .admissions
            .clone();
        tokio::time::timeout(Duration::from_secs(1), async {
            while admissions.try_write().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let other = gateway_intent(Uuid::new_v4(), "unrelated-network");
        tokio::time::timeout(Duration::from_secs(2), manager.reconcile(&other))
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            manager.remove(intent.user_id, intent.id),
        )
        .await
        .unwrap();
        assert!(accepting.await.unwrap().is_none());
        assert!(
            manager
                .actual_mesh_name(intent.user_id, intent.id)
                .await
                .is_none()
        );
        manager.remove(other.user_id, other.id).await;
    }

    #[tokio::test]
    async fn state_is_keyed_by_immutable_network_id_and_rename_replaces_index() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let id = Uuid::new_v4();
        let first = gateway_intent(id, "mesh-one");
        manager.reconcile(&first).await;

        let mut renamed = first;
        renamed.network_name = "mesh-two".to_owned();
        manager.reconcile(&renamed).await;

        assert_eq!(manager.runtime_ids().await, vec![id]);
        assert_eq!(manager.network_id_for_mesh("mesh-one").await, None);
        assert_eq!(manager.network_id_for_mesh("mesh-two").await, Some(id));
        assert_eq!(factory.stopped.lock().unwrap().as_slice(), &[id]);
    }

    #[tokio::test]
    async fn observation_requires_the_published_tenant_and_network_id() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory);
        let id = Uuid::new_v4();
        manager.reconcile(&gateway_intent(id, "mesh")).await;

        assert!(manager.observe_network(7, id).await.is_some());
        assert!(manager.observe_network(8, id).await.is_none());
        assert!(manager.observe_network(7, Uuid::new_v4()).await.is_none());
    }

    #[tokio::test]
    async fn mode_switch_and_delete_remove_runtime_by_id() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let id = Uuid::new_v4();
        let mut intent = gateway_intent(id, "mesh");
        manager.reconcile(&intent).await;

        intent.mode = NetworkMode::Standalone;
        manager.reconcile(&intent).await;
        assert!(manager.runtime_ids().await.is_empty());

        manager.reconcile(&gateway_intent(id, "mesh-again")).await;
        manager.remove(7, id).await;
        assert!(manager.runtime_ids().await.is_empty());
        assert_eq!(factory.stopped.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn failed_replacement_preserves_old_runtime_and_records_error() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let id = Uuid::new_v4();
        manager.reconcile(&gateway_intent(id, "stable")).await;

        *factory.fail_next.lock().unwrap() = true;
        manager.reconcile(&gateway_intent(id, "desired")).await;

        assert_eq!(manager.network_id_for_mesh("stable").await, Some(id));
        assert_eq!(manager.network_id_for_mesh("desired").await, None);
        assert!(factory.stopped.lock().unwrap().is_empty());
        let status = manager.deployment_status(7, id).await;
        assert_eq!(status.state, "failed");
        assert!(status.running);
    }

    #[tokio::test]
    async fn failed_start_preserves_old_runtime() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let id = Uuid::new_v4();
        manager.reconcile(&gateway_intent(id, "stable")).await;

        *factory.fail_start_next.lock().unwrap() = true;
        manager.reconcile(&gateway_intent(id, "desired")).await;

        assert_eq!(manager.network_id_for_mesh("stable").await, Some(id));
        assert_eq!(manager.network_id_for_mesh("desired").await, None);
        // Only the failed candidate was stopped, not the original runtime.
        assert_eq!(factory.stopped.lock().unwrap().as_slice(), &[id]);
    }

    #[tokio::test]
    async fn mesh_name_conflict_preserves_old_runtime() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        manager.reconcile(&gateway_intent(first_id, "stable")).await;
        manager
            .reconcile(&gateway_intent(second_id, "occupied"))
            .await;

        manager
            .reconcile(&gateway_intent(first_id, "occupied"))
            .await;

        assert_eq!(manager.network_id_for_mesh("stable").await, Some(first_id));
        assert_eq!(
            manager.network_id_for_mesh("occupied").await,
            Some(second_id)
        );
        assert!(factory.stopped.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn maps_full_grants_without_filtering_expired_credentials() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let mut intent = gateway_intent(Uuid::new_v4(), "mesh");
        intent.credentials.push(NetworkCredentialIntent {
            id: "expired-but-core-owned".to_owned(),
            secret: "credential-secret".to_owned(),
            expiry_unix: 1,
            grant: CredentialGrant {
                acl_groups: vec!["member:one".to_owned(), "ops".to_owned()],
                allow_relay: false,
                allowed_proxy_cidrs: vec!["10.0.0.0/8".to_owned()],
                reusable: false,
            },
        });

        manager.reconcile(&intent).await;

        let built = factory.built.lock().unwrap();
        assert_eq!(built[0].credentials.len(), 1);
        let credential = &built[0].credentials[0];
        assert_eq!(credential.groups, vec!["member:one", "ops"]);
        assert!(!credential.allow_relay);
        assert_eq!(credential.allowed_proxy_cidrs, vec!["10.0.0.0/8"]);
        assert_eq!(credential.expiry_unix, 1);
        assert!(!credential.reusable);
    }

    #[tokio::test]
    async fn credential_updates_are_hot_and_failures_are_retried_without_stopping_mesh() {
        let factory = Arc::new(FakeFactory::default());
        let manager = manager(factory.clone());
        let mut intent = gateway_intent(Uuid::new_v4(), "mesh");
        manager.reconcile(&intent).await;
        intent.credentials.push(NetworkCredentialIntent {
            id: "phone".into(),
            secret: "key".into(),
            expiry_unix: 100,
            grant: CredentialGrant {
                acl_groups: vec!["mobile".into()],
                allow_relay: false,
                allowed_proxy_cidrs: vec![],
                reusable: false,
            },
        });
        *factory.fail_patch.lock().unwrap() = true;
        manager.reconcile(&intent).await;
        assert_eq!(
            manager.deployment_status(7, intent.id).await.state,
            "failed"
        );
        assert_eq!(factory.built.lock().unwrap().len(), 1);
        assert!(factory.stopped.lock().unwrap().is_empty());
        manager.reconcile(&intent).await;
        assert_eq!(
            manager.deployment_status(7, intent.id).await.state,
            "applied"
        );
        assert_eq!(factory.patched.lock().unwrap().len(), 1);
        intent.credentials.clear();
        manager.reconcile(&intent).await;
        assert!(factory.patched.lock().unwrap().last().unwrap().is_empty());
        assert_eq!(factory.built.lock().unwrap().len(), 1);
        assert!(factory.stopped.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn shared_web_udp_gateway_reverse_control_uses_actual_owner_and_revokes() {
        use crate::FeatureFlags;
        use crate::client_manager::{ClientManager, HeartbeatPolicy};
        use easytier::proto::rpc::standalone::runtime_udp_tunnel_listener;
        use easytier_core::{
            connectivity::LocalListenerUrls as _, packet::UdpPacketType,
            socket::udp::parse_udp_session_datagram, tunnel::ring::create_ring_tunnel_pair,
        };
        use easytier_proto::{
            peer_rpc::{
                DirectConnectorRpc, DirectConnectorRpcClientFactory, GetIpListRequest,
                SendUdpHolePunchPacketRequest,
            },
            rpc_types::controller::BaseController,
        };
        use std::{net::SocketAddr, time::Duration};
        use tokio::{net::UdpSocket, time::timeout};

        for (bind_url, bind_addr, client_host, alias_host) in [
            ("udp://0.0.0.0:0", "0.0.0.0:0", "127.0.0.1", "198.51.100.7"),
            ("udp://[::]:0", "[::]:0", "[::1]", "[2001:db8::7]"),
        ] {
            let shared = Arc::new(shared_udp::SharedUdpControlEndpoints::default());
            let alias: url::Url = format!("udp://{alias_host}:2862").parse().unwrap();
            let instances = Arc::new(NetworkInstanceManager::with_shared_udp_control(
                GatewayConfig {
                    peer_url: alias.to_string(),
                    relay_data: true,
                },
                shared.clone(),
            ));
            let mut intent = gateway_intent(Uuid::new_v4(), "shared-udp-owner-test");
            intent.mode = NetworkMode::Gateway {
                peer_url: alias.to_string(),
            };
            instances.reconcile(&intent).await;
            let gateway = instances
                .state
                .read()
                .await
                .by_key
                .get(&GatewayRuntimeKey::from_intent(&intent))
                .unwrap()
                .runtime
                .peer_manager()
                .unwrap();
            let gateway_id = gateway.my_peer_id();

            let mut web = ClientManager::new(
                crate::db::Db::memory_db().await,
                None,
                HeartbeatPolicy::default(),
                Arc::new(FeatureFlags::default()),
                Arc::new(crate::webhook::WebhookConfig::new(
                    None, None, None, None, None,
                )),
            );
            let endpoints = shared.clone();
            let actual = web
                .add_listener_with_lifetime(
                    listener::GatewayListener::new(
                        runtime_udp_tunnel_listener(
                            bind_url.parse().unwrap(),
                            bind_addr.parse().unwrap(),
                        ),
                        instances.clone(),
                    ),
                    move |url| endpoints.register(url),
                )
                .await
                .unwrap();
            let actual_port = actual.port().unwrap();
            assert_ne!(actual_port, 0);
            assert_eq!(shared.local_listener_urls(), vec![actual]);

            let config = TomlConfigLoader::default();
            config.set_network_identity(NetworkIdentity::new(
                intent.network_name.clone(),
                intent.network_secret.clone(),
            ));
            config.set_listeners(Vec::new());
            config.set_stun_servers(Some(Vec::new()));
            config.set_stun_servers_v6(Some(Vec::new()));
            let mut flags = config.get_flags();
            flags.no_tun = true;
            flags.disable_p2p = true;
            flags.disable_upnp = true;
            flags.bind_device = false;
            config.set_flags(flags);
            let client = create_native_instance(config).unwrap();
            client.start().await.unwrap();
            client
                .add_connector(
                    format!("udp://{client_host}:{actual_port}")
                        .parse()
                        .unwrap(),
                )
                .unwrap();
            timeout(Duration::from_secs(5), async {
                loop {
                    if client
                        .peer_manager()
                        .list_peer_snapshots()
                        .await
                        .iter()
                        .any(|peer| peer.peer_id == gateway_id && !peer.conns.is_empty())
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the real shared Gateway listener must admit the client mesh");

            let rpc = client
                .peer_manager()
                .get_peer_rpc_mgr()
                .rpc_client()
                .scoped_client::<DirectConnectorRpcClientFactory<BaseController>>(
                client.peer_id(),
                gateway_id,
                intent.network_name.clone(),
            );
            let discovered = rpc
                .get_ip_list(BaseController::default(), GetIpListRequest {})
                .await
                .unwrap();
            assert_eq!(
                discovered
                    .listeners
                    .into_iter()
                    .map(url::Url::from)
                    .filter(|url| url.scheme() == "udp")
                    .collect::<Vec<_>>(),
                vec![alias]
            );
            let receiver = UdpSocket::bind(format!("{client_host}:0")).await.unwrap();
            let receiver_addr: SocketAddr = receiver.local_addr().unwrap();
            let request = SendUdpHolePunchPacketRequest {
                listener_port: 2862,
                connector_addr: Some(receiver_addr.into()),
                ..Default::default()
            };
            rpc.send_udp_hole_punch_packet(BaseController::default(), request.clone())
                .await
                .unwrap();
            let mut buffer = [0; 128];
            let (len, source) = timeout(Duration::from_secs(2), receiver.recv_from(&mut buffer))
                .await
                .unwrap()
                .unwrap();
            let packet = parse_udp_session_datagram((&buffer[..len]).into(), false).unwrap();
            assert_eq!(
                packet.udp_tunnel_header().unwrap().msg_type,
                UdpPacketType::HolePunch as u8
            );
            assert_eq!(source.port(), actual_port);
            assert_eq!(source.is_ipv6(), receiver_addr.is_ipv6());

            // Preserve an independent authenticated RPC path while the shared
            // UDP owner is removed, so rejection is the lookup result rather
            // than a disconnected management channel.
            let (server_ring, client_ring) = create_ring_tunnel_pair();
            let (admitted, connected) = tokio::join!(
                gateway.add_tunnel_as_server(server_ring),
                client.peer_manager().add_client_tunnel(client_ring),
            );
            admitted.unwrap();
            assert_eq!(connected.unwrap().0, gateway_id);
            for peers in [client.peer_manager().clone(), gateway.clone()] {
                for peer in peers.list_peer_snapshots().await {
                    for conn in peer.conns {
                        if conn
                            .tunnel
                            .as_ref()
                            .is_some_and(|tunnel| tunnel.tunnel_type == "udp")
                        {
                            peers
                                .close_peer_conn(peer.peer_id, &conn.conn_id.parse().unwrap())
                                .await
                                .unwrap();
                        }
                    }
                }
            }
            // The same handler still works over the independent mesh path.
            rpc.send_udp_hole_punch_packet(BaseController::default(), request.clone())
                .await
                .unwrap();
            drop(web);
            timeout(Duration::from_secs(1), async {
                while !shared.local_listener_urls().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the shared listener owner must revoke its actual endpoint");
            let rejected = rpc
                .send_udp_hole_punch_packet(BaseController::default(), request)
                .await
                .unwrap_err();
            assert!(
                rejected.to_string().contains("has no running"),
                "{rejected}"
            );
            client.stop().await;
            instances.remove(intent.user_id, intent.id).await;
        }
    }

    #[tokio::test]
    async fn native_credential_patch_updates_shared_config_without_changing_peer_identity() {
        let config = TomlConfigLoader::default();
        config.set_network_identity(NetworkIdentity::new(
            "native-hot-update".into(),
            "secret".into(),
        ));
        config.set_listeners(vec![]);
        let mut flags = config.get_flags();
        flags.no_tun = true;
        config.set_flags(flags);
        let native = create_native_instance(config).unwrap();
        let runtime = NativeGatewayRuntime(native.clone());
        runtime.start().await.unwrap();
        let peer_id = native.peer_manager().my_peer_id();
        let credential = ManagedCredentialConfig {
            credential_id: "phone".into(),
            credential_secret: base64::engine::general_purpose::STANDARD.encode([7u8; 32]),
            groups: vec!["mobile".into()],
            allow_relay: false,
            allowed_proxy_cidrs: vec!["10.0.0.0/8".into()],
            expiry_unix: chrono::Utc::now().timestamp() + 3600,
            reusable: false,
        };
        runtime
            .replace_credentials(std::slice::from_ref(&credential))
            .await
            .unwrap();
        assert_eq!(native.peer_manager().my_peer_id(), peer_id);
        assert_eq!(
            native.toml_config().unwrap().get_managed_credentials(),
            vec![credential]
        );
        assert_eq!(native.credential_snapshots().len(), 1);
        runtime.replace_credentials(&[]).await.unwrap();
        assert_eq!(native.peer_manager().my_peer_id(), peer_id);
        assert!(
            native
                .toml_config()
                .unwrap()
                .get_managed_credentials()
                .is_empty()
        );
        assert!(native.credential_snapshots().is_empty());
        runtime.stop().await;
    }

    #[tokio::test]
    async fn failed_native_replacement_keeps_actual_gateway_topology_identity() {
        let manager = NetworkInstanceManager::new(GatewayConfig {
            peer_url: "tcp://localhost:22020".into(),
            relay_data: false,
        });
        let mut intent = gateway_intent(Uuid::new_v4(), "native-topology");
        assert!(
            manager
                .deployment_status(intent.user_id, intent.id)
                .await
                .peer_id
                .is_none()
        );
        manager.reconcile(&intent).await;
        let initial = manager.deployment_status(intent.user_id, intent.id).await;
        assert!(initial.peer_id.is_some_and(|id| id > 0));
        intent.network_name = "replacement-mesh".into();
        intent.credentials.push(NetworkCredentialIntent {
            id: "invalid".into(),
            secret: "invalid-base64-key".into(),
            expiry_unix: i64::MAX,
            grant: CredentialGrant {
                acl_groups: vec![],
                allow_relay: false,
                allowed_proxy_cidrs: vec![],
                reusable: false,
            },
        });
        manager.reconcile(&intent).await;
        let failed = manager.deployment_status(intent.user_id, intent.id).await;
        assert_eq!(failed.state, "failed");
        assert!(failed.running);
        assert_eq!(failed.peer_id, initial.peer_id);
        assert_eq!(failed.peer_url.as_deref(), Some("tcp://localhost:22020"));
        manager.remove(intent.user_id, intent.id).await;
        assert!(
            manager
                .deployment_status(intent.user_id, intent.id)
                .await
                .peer_id
                .is_none()
        );
    }

    #[test]
    fn gateway_peer_url_scheme_must_match_listener_protocol() {
        let tcp = GatewayConfig {
            peer_url: "tcp://gateway.example:22020".to_owned(),
            relay_data: false,
        };
        assert!(tcp.validate("tcp").is_ok());
        assert!(tcp.validate("udp").is_err());
        assert!(tcp.validate("unknown").is_err());

        let secure_websocket = GatewayConfig {
            peer_url: "wss://gateway.example/mesh".to_owned(),
            relay_data: false,
        };
        assert!(secure_websocket.validate("ws").is_ok());
    }
}
