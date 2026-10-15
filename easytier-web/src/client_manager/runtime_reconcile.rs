use anyhow::Context as _;
use easytier::{
    common::config::{
        ConfigLoader, EncryptionAlgorithm, NetworkConfigExt,
        PortForwardConfig as RuntimePortForwardConfig,
        VpnPortalClientConfig as RuntimeVpnPortalClientConfig,
        VpnPortalConfig as RuntimeVpnPortalConfig,
    },
    proto::{
        acl::Acl,
        api::{
            config::{
                AclPatch, ConfigPatchAction, ExitNodePatch, InstanceConfigPatch,
                PatchConfigRequest, PortForwardPatch, ProxyNetworkPatch, VpnPortalClientPatch,
            },
            instance::{InstanceIdentifier, instance_identifier},
            manage::{
                ConfigSource as RpcConfigSource, GetNetworkInstanceConfigRequest,
                ManagedCredentialConfig, ManagedCredentialSet, NetworkConfig,
                RunNetworkInstanceRequest,
            },
        },
        common::{CompressionAlgoPb, Ipv4Inet as RpcIpv4Inet},
        rpc_types::controller::BaseController,
    },
};

use super::session::{SessionConfigClient, SessionRpcClient};

#[derive(Debug, thiserror::Error)]
#[error("This client Core does not support IPv6 preference; update the client before enabling it")]
pub(super) struct UnsupportedIpv6Preference;

#[derive(Debug, thiserror::Error)]
#[error(
    "This configuration requires EasyTier Core 2.7.2 or newer; upgrade the target client before applying it"
)]
pub(crate) struct UnsupportedExtendedConfig;

pub(crate) fn requires_extended_config(config: &NetworkConfig) -> bool {
    config.default_protocol.is_some()
        || config.stun_servers.is_some()
        || config.tcp_stun_servers.is_some()
        || config.stun_servers_v6.is_some()
        || config.foreign_relay_bps_limit.is_some()
        || config.disable_relay_kcp.is_some()
        || config.disable_relay_quic.is_some()
        || config.enable_relay_foreign_network_kcp.is_some()
        || config.enable_relay_foreign_network_quic.is_some()
        || config.tld_dns_zone.is_some()
        || config.virtual_ipv6.is_some()
        || config.tcp_whitelist.is_some()
        || config.udp_whitelist.is_some()
        || config.socks5_proxy.is_some()
        || config.instance_name.is_some()
        || config.netns.is_some()
}

pub(crate) fn ensure_extended_config_supported(
    desired: &NetworkConfig,
    current: Option<&NetworkConfig>,
    client_version: Option<&str>,
) -> anyhow::Result<()> {
    if !requires_extended_config(desired)
        || current.is_some_and(|config| config.default_protocol.is_some())
        || client_version.is_some_and(supports_extended_config_version)
    {
        return Ok(());
    }
    Err(UnsupportedExtendedConfig.into())
}

fn supports_extended_config_version(version: &str) -> bool {
    let version = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let release = version.split(['-', '+', ' ']).next().unwrap_or_default();
    let mut components = release.split('.');
    let Some(major) = components.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let Some(minor) = components.next().and_then(|part| part.parse::<u32>().ok()) else {
        return false;
    };
    let patch = match components.next() {
        Some(part) => match part.parse::<u32>() {
            Ok(patch) => patch,
            Err(_) => return false,
        },
        None => 0,
    };
    components.next().is_none() && (major, minor, patch) >= (2, 7, 2)
}

pub(super) enum RuntimeReconcileAction {
    Unchanged(Box<NetworkConfig>),
    Run {
        config: Box<NetworkConfig>,
        overwrite: bool,
    },
    Patch(Box<InstanceConfigPatch>),
}

#[derive(Clone, PartialEq)]
struct RuntimeProxyNetwork {
    cidr: String,
    mapped_cidr: Option<String>,
}

fn instance_identifier(inst_id: &str) -> anyhow::Result<InstanceIdentifier> {
    let inst_id = uuid::Uuid::parse_str(inst_id)
        .with_context(|| format!("invalid runtime instance id: {inst_id}"))?;
    Ok(InstanceIdentifier {
        selector: Some(instance_identifier::Selector::Id(inst_id.into())),
    })
}

fn hot_patch_base(config: &NetworkConfig) -> anyhow::Result<NetworkConfig> {
    let data_compress_algo = normalized_data_compress_algo(config.data_compress_algo);
    let encryption_algorithm = normalized_encryption_algorithm(config.encryption_algorithm.clone());
    let mut config = NetworkConfig::new_from_config(config.gen_config()?)?;
    let is_credential_mode = config.network_secret.is_none()
        && config
            .secure_mode
            .as_ref()
            .and_then(|mode| mode.local_private_key.as_deref())
            .is_some_and(|key| !key.is_empty());
    config.acl = None;
    config.port_forwards.clear();
    config.proxy_cidrs.clear();
    config.disable_relay_data = None;
    config.prefer_peer_relay = None;
    // VPN portal clients are diffed separately; the listener identity
    // (address and private key) decides between patch and recreate.
    config.vpn_portal_config = None;
    config.managed_credentials.clear();
    config.exit_nodes.clear();
    if config.dhcp.unwrap_or_default() {
        config.virtual_ipv4 = None;
        config.network_length = None;
    }
    if let Some(secure_mode) = config.secure_mode.as_mut() {
        if !is_credential_mode {
            secure_mode.local_private_key = None;
        }
        secure_mode.local_public_key = None;
    }
    config.data_compress_algo = data_compress_algo;
    config.encryption_algorithm = encryption_algorithm;
    Ok(config)
}

fn normalized_data_compress_algo(algo: Option<i32>) -> Option<i32> {
    let default = CompressionAlgoPb::None as i32;
    let effective = algo.map(|algo| if algo < default { default } else { algo });
    effective.filter(|algo| *algo != default)
}

fn normalized_encryption_algorithm(algo: Option<String>) -> Option<String> {
    let default = EncryptionAlgorithm::default().to_string();
    algo.filter(|algo| algo != &default)
}

fn diff_port_forwards(
    current: &[RuntimePortForwardConfig],
    desired: &[RuntimePortForwardConfig],
) -> Vec<PortForwardPatch> {
    let mut patches = Vec::new();
    for cfg in unique_port_forwards(current, desired) {
        let current_count = current.iter().filter(|item| *item == &cfg).count();
        let desired_count = desired.iter().filter(|item| *item == &cfg).count();
        if current_count == desired_count {
            continue;
        }
        if current_count > 0 {
            patches.push(PortForwardPatch {
                action: ConfigPatchAction::Remove as i32,
                cfg: Some(cfg.clone().into()),
            });
        }
        patches.extend((0..desired_count).map(|_| PortForwardPatch {
            action: ConfigPatchAction::Add as i32,
            cfg: Some(cfg.clone().into()),
        }));
    }
    patches
}

fn unique_port_forwards(
    current: &[RuntimePortForwardConfig],
    desired: &[RuntimePortForwardConfig],
) -> Vec<RuntimePortForwardConfig> {
    let mut unique = Vec::new();
    for cfg in current.iter().chain(desired.iter()) {
        if !unique.contains(cfg) {
            unique.push(cfg.clone());
        }
    }
    unique
}

fn parse_rpc_ipv4_inet(value: &str) -> anyhow::Result<RpcIpv4Inet> {
    value
        .parse::<RpcIpv4Inet>()
        .with_context(|| format!("failed to parse runtime ipv4 cidr: {value}"))
}

fn diff_proxy_networks(
    current: &[RuntimeProxyNetwork],
    desired: &[RuntimeProxyNetwork],
) -> anyhow::Result<Vec<ProxyNetworkPatch>> {
    if current == desired {
        return Ok(Vec::new());
    }

    let mut patches = vec![ProxyNetworkPatch {
        action: ConfigPatchAction::Clear as i32,
        cidr: Some(clear_proxy_network_cidr(current, desired)?),
        ..Default::default()
    }];
    for proxy_network in desired {
        patches.push(ProxyNetworkPatch {
            action: ConfigPatchAction::Add as i32,
            cidr: Some(parse_rpc_ipv4_inet(&proxy_network.cidr)?),
            mapped_cidr: proxy_network
                .mapped_cidr
                .as_deref()
                .map(parse_rpc_ipv4_inet)
                .transpose()?,
        });
    }
    Ok(patches)
}

fn clear_proxy_network_cidr(
    current: &[RuntimeProxyNetwork],
    desired: &[RuntimeProxyNetwork],
) -> anyhow::Result<RpcIpv4Inet> {
    let cidr = desired
        .first()
        .or_else(|| current.first())
        .map(|proxy_network| proxy_network.cidr.as_str())
        .unwrap_or("0.0.0.0/0");
    parse_rpc_ipv4_inet(cidr)
}

fn normalized_acl(acl: &Option<Acl>) -> Option<Acl> {
    let acl = acl.clone().unwrap_or_default();
    (acl != Acl::default()).then_some(acl)
}

fn normalized_port_forwards(
    config: &NetworkConfig,
) -> anyhow::Result<Vec<RuntimePortForwardConfig>> {
    Ok(config
        .gen_config()?
        .get_port_forwards()
        .into_iter()
        .map(|cfg| {
            RuntimePortForwardConfig::from(easytier::proto::common::PortForwardConfigPb::from(cfg))
        })
        .collect())
}

fn normalized_proxy_networks(config: &NetworkConfig) -> anyhow::Result<Vec<RuntimeProxyNetwork>> {
    Ok(config
        .gen_config()?
        .get_proxy_cidrs()
        .into_iter()
        .map(|proxy_network| RuntimeProxyNetwork {
            cidr: proxy_network.cidr.to_string(),
            mapped_cidr: proxy_network.mapped_cidr.map(|cidr| cidr.to_string()),
        })
        .collect())
}

fn normalized_disable_relay_data(config: &NetworkConfig) -> anyhow::Result<bool> {
    Ok(config.gen_config()?.get_flags().disable_relay_data)
}

fn normalized_prefer_peer_relay(config: &NetworkConfig) -> anyhow::Result<bool> {
    Ok(config.gen_config()?.get_flags().prefer_peer_relay)
}

fn normalized_vpn_portal(config: &NetworkConfig) -> anyhow::Result<Option<RuntimeVpnPortalConfig>> {
    Ok(config.gen_config()?.get_vpn_portal_config())
}

fn diff_vpn_portal_clients(
    current: &[RuntimeVpnPortalClientConfig],
    desired: &[RuntimeVpnPortalClientConfig],
) -> Vec<VpnPortalClientPatch> {
    let mut patches = Vec::new();
    // Removals first so a virtual IP moved between clients never exists
    // twice inside one patch request.
    for client in current {
        match desired.iter().find(|desired| desired.name == client.name) {
            Some(matching) if matching == client => {}
            _ => patches.push(VpnPortalClientPatch {
                action: ConfigPatchAction::Remove as i32,
                client: Some(client_name_only(&client.name)),
            }),
        }
    }
    for client in desired {
        if current
            .iter()
            .find(|existing| existing.name == client.name)
            .is_none_or(|existing| existing != client)
        {
            patches.push(VpnPortalClientPatch {
                action: ConfigPatchAction::Add as i32,
                client: Some(easytier::proto::api::manage::VpnPortalClientConfig {
                    name: client.name.clone(),
                    virtual_ip: client.virtual_ip.to_string(),
                    groups: client.groups.clone(),
                }),
            });
        }
    }
    patches
}

fn client_name_only(name: &str) -> easytier::proto::api::manage::VpnPortalClientConfig {
    easytier::proto::api::manage::VpnPortalClientConfig {
        name: name.to_owned(),
        virtual_ip: String::new(),
        groups: Vec::new(),
    }
}

fn normalized_managed_credentials(
    config: &NetworkConfig,
) -> anyhow::Result<Vec<ManagedCredentialConfig>> {
    Ok(NetworkConfig::new_from_config(config.gen_config()?)?.managed_credentials)
}

fn is_automatic_windows_dev_name(dev_name: &str) -> bool {
    let Some((interface_count, suffix)) = dev_name
        .strip_prefix("et_")
        .and_then(|value| value.split_once('_'))
    else {
        return false;
    };
    !interface_count.is_empty()
        && interface_count.bytes().all(|byte| byte.is_ascii_digit())
        && suffix.len() == 4
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn web_source_runtime_patch(
    current: &NetworkConfig,
    desired: &NetworkConfig,
) -> anyhow::Result<Option<InstanceConfigPatch>> {
    let mut current_base = hot_patch_base(current)?;
    let mut desired_base = hot_patch_base(desired)?;
    if desired.dev_name.is_none()
        || (desired.dev_name.as_deref() == Some("")
            && current
                .dev_name
                .as_deref()
                .is_some_and(is_automatic_windows_dev_name))
    {
        current_base.dev_name = None;
        desired_base.dev_name = None;
    }
    let current_hostname = current_base.hostname.take().unwrap_or_default();
    let desired_hostname = desired_base.hostname.take().unwrap_or_default();
    if current_base != desired_base {
        return Ok(None);
    }

    let mut patch = InstanceConfigPatch::default();
    if desired.hostname.is_some() && current_hostname != desired_hostname {
        patch.hostname = Some(desired_hostname);
    }
    let current_acl = normalized_acl(&current.acl);
    let desired_acl = normalized_acl(&desired.acl);
    if current_acl != desired_acl {
        patch.acl = Some(AclPatch {
            acl: Some(desired_acl.unwrap_or_default()),
            ..Default::default()
        });
    }

    let current_port_forwards = normalized_port_forwards(current)?;
    let desired_port_forwards = normalized_port_forwards(desired)?;
    if current_port_forwards != desired_port_forwards {
        patch.port_forwards = diff_port_forwards(&current_port_forwards, &desired_port_forwards);
    }

    let current_proxy_networks = normalized_proxy_networks(current)?;
    let desired_proxy_networks = normalized_proxy_networks(desired)?;
    if current_proxy_networks != desired_proxy_networks {
        if current_proxy_networks.is_empty() {
            return Ok(None);
        }
        patch.proxy_networks =
            diff_proxy_networks(&current_proxy_networks, &desired_proxy_networks)?;
    }

    let current_disable_relay_data = normalized_disable_relay_data(current)?;
    let desired_disable_relay_data = normalized_disable_relay_data(desired)?;
    if current_disable_relay_data != desired_disable_relay_data {
        patch.disable_relay_data = Some(desired_disable_relay_data);
    }

    let current_prefer_peer_relay = normalized_prefer_peer_relay(current)?;
    let desired_prefer_peer_relay = normalized_prefer_peer_relay(desired)?;
    if current_prefer_peer_relay != desired_prefer_peer_relay {
        patch.prefer_peer_relay = Some(desired_prefer_peer_relay);
    }

    match (
        normalized_vpn_portal(current)?,
        normalized_vpn_portal(desired)?,
    ) {
        (Some(current_portal), Some(desired_portal)) => {
            if current_portal.enabled.unwrap_or(true) != desired_portal.enabled.unwrap_or(true)
                || current_portal.wireguard_listen != desired_portal.wireguard_listen
                || current_portal.wireguard_private_key != desired_portal.wireguard_private_key
            {
                // The listener identity changed; the portal must be rebuilt.
                return Ok(None);
            }
            if current_portal.clients != desired_portal.clients {
                if desired_portal.enabled == Some(false) {
                    return Ok(None);
                }
                patch.vpn_portal_clients =
                    diff_vpn_portal_clients(&current_portal.clients, &desired_portal.clients);
            }
        }
        // Enabling or disabling the portal changes the listener lifecycle.
        (Some(_), None) | (None, Some(_)) => return Ok(None),
        (None, None) => {}
    }
    let current_exit_nodes = current.gen_config()?.get_exit_nodes();
    let desired_exit_nodes = desired.gen_config()?.get_exit_nodes();
    if current_exit_nodes != desired_exit_nodes {
        // Clear then add preserves the configured priority order, including
        // removals to an empty set. Core commits TOML and updates live routing.
        patch.exit_nodes.push(ExitNodePatch {
            action: ConfigPatchAction::Clear as i32,
            node: None,
        });
        patch
            .exit_nodes
            .extend(desired_exit_nodes.into_iter().map(|node| ExitNodePatch {
                action: ConfigPatchAction::Add as i32,
                node: Some(node.into()),
            }));
    }

    let current_managed_credentials = normalized_managed_credentials(current)?;
    let desired_managed_credentials = normalized_managed_credentials(desired)?;
    if current_managed_credentials != desired_managed_credentials {
        patch.managed_credentials = Some(ManagedCredentialSet {
            entries: desired_managed_credentials,
        });
    }

    Ok(Some(patch))
}

// Release 2.6.4 omits a configured hostname that matches the device
// hostname from config readback. After a successful hostname mutation the
// desired value must be restored into the observed config, otherwise every
// later plan re-sends the same hostname patch.
pub(super) fn restore_omitted_hostname(
    current: &mut NetworkConfig,
    desired: &NetworkConfig,
    hostname_applied: bool,
) {
    if hostname_applied && current.hostname.is_none() && desired.hostname.is_some() {
        current.hostname = desired.hostname.clone();
    }
}

pub(super) fn ensure_runtime_config_converged(
    current: &NetworkConfig,
    desired: &NetworkConfig,
    hostname_applied: bool,
) -> anyhow::Result<()> {
    let patch = web_source_runtime_patch(current, desired)?;
    match patch {
        Some(mut patch) => {
            // Release 2.6.4 omits a configured hostname when it equals
            // the device hostname. The successful mutation is therefore
            // authoritative for hostname, while every other field remains
            // verified from the runtime readback.
            if hostname_applied && current.hostname.is_none() {
                patch.hostname = None;
            }
            if patch == InstanceConfigPatch::default() {
                Ok(())
            } else {
                anyhow::bail!("runtime config still needs patch after reconcile")
            }
        }
        None => anyhow::bail!("runtime config still needs full overwrite after reconcile"),
    }
}

async fn run_web_source_instance(
    rpc_client: &mut SessionRpcClient,
    inst_id: &str,
    config: NetworkConfig,
    overwrite: bool,
) -> anyhow::Result<()> {
    rpc_client
        .run_network_instance(
            BaseController::default(),
            RunNetworkInstanceRequest {
                inst_id: Some(inst_id.to_string().into()),
                config: Some(config),
                overwrite,
                source: RpcConfigSource::Web as i32,
            },
        )
        .await?;
    Ok(())
}

pub(super) async fn get_runtime_config(
    rpc_client: &mut SessionRpcClient,
    inst_id: &str,
) -> anyhow::Result<NetworkConfig> {
    rpc_client
        .get_network_instance_config(
            BaseController::default(),
            GetNetworkInstanceConfigRequest {
                inst_id: Some(inst_id.to_string().into()),
            },
        )
        .await?
        .config
        .ok_or_else(|| anyhow::anyhow!("runtime returned empty config for {inst_id}"))
}

pub(super) async fn prepare_web_source_runtime_reconcile(
    rpc_client: &mut SessionRpcClient,
    inst_id: &str,
    desired_config: NetworkConfig,
    is_running: bool,
    client_version: Option<&str>,
) -> anyhow::Result<RuntimeReconcileAction> {
    if !is_running {
        ensure_extended_config_supported(&desired_config, None, client_version)?;
        return Ok(RuntimeReconcileAction::Run {
            config: Box::new(desired_config),
            overwrite: false,
        });
    }

    let current_config = get_runtime_config(rpc_client, inst_id).await?;

    prepare_web_source_runtime_reconcile_from_current(&current_config, desired_config)
}

pub(super) fn prepare_web_source_runtime_reconcile_from_current(
    current_config: &NetworkConfig,
    desired_config: NetworkConfig,
) -> anyhow::Result<RuntimeReconcileAction> {
    ensure_extended_config_supported(&desired_config, Some(current_config), None)?;
    // The optional DTO field is also a capability marker: updated Core always
    // reports Some(false/true), while older Core omits it. Avoid repeatedly
    // rebuilding a running legacy instance for a preference it cannot apply.
    if desired_config.prefer_ipv6 == Some(true) && current_config.prefer_ipv6.is_none() {
        return Err(UnsupportedIpv6Preference.into());
    }
    let Some(patch) = web_source_runtime_patch(current_config, &desired_config)? else {
        let mut run_config = desired_config;
        if run_config.hostname.is_none() {
            run_config.hostname = current_config.hostname.clone();
        }
        return Ok(RuntimeReconcileAction::Run {
            config: Box::new(run_config),
            overwrite: true,
        });
    };
    if patch == InstanceConfigPatch::default() {
        return Ok(RuntimeReconcileAction::Unchanged(Box::new(
            current_config.clone(),
        )));
    }

    Ok(RuntimeReconcileAction::Patch(Box::new(patch)))
}

pub(super) async fn apply_web_source_runtime_reconcile(
    rpc_client: &mut SessionRpcClient,
    config_client: &mut SessionConfigClient,
    inst_id: &str,
    desired_config: NetworkConfig,
    action: RuntimeReconcileAction,
) -> anyhow::Result<NetworkConfig> {
    match action {
        RuntimeReconcileAction::Unchanged(current_config) => Ok(*current_config),
        RuntimeReconcileAction::Run { config, overwrite } => {
            let hostname_applied = config.hostname.is_some();
            run_web_source_instance(rpc_client, inst_id, *config, overwrite).await?;
            let mut current_config = get_runtime_config(rpc_client, inst_id).await?;
            ensure_runtime_config_converged(&current_config, &desired_config, hostname_applied)?;
            restore_omitted_hostname(&mut current_config, &desired_config, hostname_applied);
            Ok(current_config)
        }
        RuntimeReconcileAction::Patch(patch) => {
            let hostname_applied = patch.hostname.is_some();
            config_client
                .patch_config(
                    BaseController::default(),
                    PatchConfigRequest {
                        instance: Some(instance_identifier(inst_id)?),
                        patch: Some(*patch),
                    },
                )
                .await?;
            let mut current_config = get_runtime_config(rpc_client, inst_id).await?;
            ensure_runtime_config_converged(&current_config, &desired_config, hostname_applied)?;
            restore_omitted_hostname(&mut current_config, &desired_config, hostname_applied);
            Ok(current_config)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn prefer_ipv6_requires_updated_core_without_rebuilding_legacy_runtime() {
        let current = super::NetworkConfig::default();
        let desired = super::NetworkConfig {
            prefer_ipv6: Some(true),
            ..current.clone()
        };
        let error = super::prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .err()
            .expect("legacy Core must not enter a recreate loop");
        assert!(error.to_string().contains("update the client"));
    }

    #[test]
    fn prefer_ipv6_disabled_is_compatible_with_legacy_core_metadata() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();
        desired.prefer_ipv6 = Some(false);
        assert!(matches!(
            prepare_web_source_runtime_reconcile_from_current(&current, desired).unwrap(),
            RuntimeReconcileAction::Unchanged(_)
        ));
    }

    use easytier::proto::{
        api::{
            config::ConfigPatchAction,
            manage::{NetworkingMethod, PortForwardConfig},
        },
        common::{CompressionAlgoPb, SocketType},
    };

    use super::*;

    #[test]
    fn extended_config_rejects_every_new_field_before_legacy_runtime_mutation() {
        for (field, value) in [
            ("default_protocol", serde_json::json!("tcp")),
            ("stun_servers", serde_json::json!({"values": []})),
            ("tcp_stun_servers", serde_json::json!({"values": []})),
            ("stun_servers_v6", serde_json::json!({"values": []})),
            ("foreign_relay_bps_limit", serde_json::json!("0")),
            ("disable_relay_kcp", serde_json::json!(false)),
            ("disable_relay_quic", serde_json::json!(false)),
            ("enable_relay_foreign_network_kcp", serde_json::json!(false)),
            (
                "enable_relay_foreign_network_quic",
                serde_json::json!(false),
            ),
            ("tld_dns_zone", serde_json::json!("et.net.")),
            ("virtual_ipv6", serde_json::json!("fd00::1/64")),
            ("tcp_whitelist", serde_json::json!({"values": []})),
            ("udp_whitelist", serde_json::json!({"values": []})),
            ("socks5_proxy", serde_json::json!("")),
            ("instance_name", serde_json::json!("instance")),
            ("netns", serde_json::json!("")),
        ] {
            let desired: NetworkConfig =
                serde_json::from_value(serde_json::json!({(field): value})).unwrap();
            let error = prepare_web_source_runtime_reconcile_from_current(
                &NetworkConfig::default(),
                desired.clone(),
            )
            .err()
            .expect("legacy Core must not enter a recreate loop for a new DTO field");
            assert!(error.is::<UnsupportedExtendedConfig>(), "{field}");
            assert!(error.to_string().contains("2.7.2"));
            assert!(
                ensure_extended_config_supported(&desired, None, Some("2.7.1-release")).is_err(),
                "{field}"
            );
            assert!(
                ensure_extended_config_supported(&desired, None, Some("2.7.2-release")).is_ok(),
                "{field}"
            );
        }
    }

    #[test]
    fn extended_config_accepts_runtime_capability_or_new_heartbeat_for_first_instance() {
        let desired = NetworkConfig {
            default_protocol: Some("udp".to_owned()),
            ..Default::default()
        };
        let current = NetworkConfig {
            default_protocol: Some("tcp".to_owned()),
            ..Default::default()
        };
        assert!(
            ensure_extended_config_supported(&desired, Some(&current), Some("2.7.1-backport"))
                .is_ok()
        );
        assert!(ensure_extended_config_supported(&desired, None, None).is_err());
        for version in ["2.7.2", "2.7.2-new", "v2.7.2+build", "2.8", "3.0.0"] {
            assert!(
                ensure_extended_config_supported(&desired, None, Some(version)).is_ok(),
                "{version}"
            );
        }
        for version in [
            "",
            "unknown",
            "2.7",
            "2.7.1",
            "2.6.99",
            "2.7.2.1",
            "bad.2.7.2",
        ] {
            assert!(
                ensure_extended_config_supported(&desired, None, Some(version)).is_err(),
                "{version}"
            );
        }
    }

    #[test]
    fn legacy_configs_and_preexisting_transport_fields_do_not_require_upgrade() {
        let desired = NetworkConfig {
            data_compress_algo: Some(2),
            enable_kcp_proxy: Some(true),
            disable_kcp_input: Some(false),
            enable_quic_proxy: Some(false),
            disable_quic_input: Some(true),
            encryption_algorithm: Some("aes-256-gcm".to_owned()),
            disable_encryption: Some(false),
            ..Default::default()
        };
        assert!(!requires_extended_config(&desired));
        assert!(ensure_extended_config_supported(&desired, None, Some("2.7.1")).is_ok());
    }

    #[test]
    fn exit_nodes_patch_preserves_order_and_supports_empty_set() {
        let mut current = config_with_port_forwards(vec![]);
        current.exit_nodes = vec!["10.144.0.2".into(), "fd00::2".into()];
        let mut desired = current.clone();
        desired.exit_nodes.reverse();
        let patch = web_source_runtime_patch(&current, &desired)
            .unwrap()
            .unwrap();
        assert_eq!(patch.exit_nodes.len(), 3);
        assert_eq!(patch.exit_nodes[0].action, ConfigPatchAction::Clear as i32);
        assert_eq!(
            std::net::IpAddr::from(patch.exit_nodes[1].node.unwrap()).to_string(),
            "fd00::2"
        );
        desired.exit_nodes.clear();
        let patch = web_source_runtime_patch(&current, &desired)
            .unwrap()
            .unwrap();
        assert_eq!(patch.exit_nodes.len(), 1);
        assert_eq!(patch.exit_nodes[0].action, ConfigPatchAction::Clear as i32);
        assert!(patch.exit_nodes[0].node.is_none());
    }

    fn config_with_port_forwards(port_forwards: Vec<PortForwardConfig>) -> NetworkConfig {
        NetworkConfig {
            instance_id: Some("11111111-1111-1111-1111-111111111111".to_string()),
            dhcp: Some(true),
            network_name: Some("managed".to_string()),
            network_secret: Some("secret".to_string()),
            networking_method: Some(NetworkingMethod::Manual as i32),
            port_forwards,
            ..Default::default()
        }
    }

    fn port_forward(bind_port: u32, dst_port: u32) -> PortForwardConfig {
        PortForwardConfig {
            bind_ip: "127.0.0.1".to_string(),
            bind_port,
            dst_ip: "10.144.0.1".to_string(),
            dst_port,
            proto: "tcp".to_string(),
        }
    }

    fn patch_port(patch: &PortForwardPatch) -> (i32, u32, u32, i32) {
        let cfg = patch.cfg.as_ref().expect("port forward patch cfg");
        (
            patch.action,
            cfg.bind_addr.as_ref().expect("bind addr").port,
            cfg.dst_addr.as_ref().expect("dst addr").port,
            cfg.socket_type,
        )
    }

    fn patch_proxy_network(patch: &ProxyNetworkPatch) -> (i32, String, Option<String>) {
        (
            patch.action,
            patch.cidr.map(|cidr| cidr.to_string()).unwrap_or_default(),
            patch.mapped_cidr.map(|cidr| cidr.to_string()),
        )
    }

    fn portal_client(name: &str, ip: &str) -> easytier::proto::api::manage::VpnPortalClientConfig {
        easytier::proto::api::manage::VpnPortalClientConfig {
            name: name.to_owned(),
            virtual_ip: ip.to_owned(),
            groups: Vec::new(),
        }
    }

    fn config_with_vpn_portal(
        clients: Vec<easytier::proto::api::manage::VpnPortalClientConfig>,
        listen: &str,
    ) -> NetworkConfig {
        let mut config = config_with_port_forwards(Vec::new());
        config.dhcp = Some(false);
        config.virtual_ipv4 = Some("10.144.0.1".to_string());
        config.network_length = Some(24);
        config.vpn_portal_config = Some(easytier::proto::api::manage::VpnPortalConfig {
            enabled: None,
            wireguard_listen: listen.to_owned(),
            wireguard_private_key: Some("dGVzdC1rZXk=".to_owned()),
            clients,
        });
        config
    }

    fn patch_vpn_portal_actions(patch: &InstanceConfigPatch) -> Vec<(i32, String)> {
        patch
            .vpn_portal_clients
            .iter()
            .map(|client_patch| {
                (
                    client_patch.action,
                    client_patch
                        .client
                        .as_ref()
                        .map(|client| client.name.clone())
                        .unwrap_or_default(),
                )
            })
            .collect()
    }

    #[test]
    fn vpn_portal_client_changes_produce_hot_patches() {
        let current = config_with_vpn_portal(
            vec![
                portal_client("alice", "10.144.144.4/24"),
                portal_client("carol", "10.144.144.6/24"),
            ],
            "0.0.0.0:22121",
        );
        let desired = config_with_vpn_portal(
            vec![
                portal_client("bob", "10.144.144.5/24"),
                portal_client("carol", "10.144.144.7/24"),
            ],
            "0.0.0.0:22121",
        );

        let patch = web_source_runtime_patch(&current, &desired)
            .unwrap()
            .expect("client-only changes must be hot-patchable");

        assert_eq!(
            patch_vpn_portal_actions(&patch),
            vec![
                (ConfigPatchAction::Remove as i32, "alice".to_owned()),
                (ConfigPatchAction::Remove as i32, "carol".to_owned()),
                (ConfigPatchAction::Add as i32, "bob".to_owned()),
                (ConfigPatchAction::Add as i32, "carol".to_owned()),
            ],
            "removals must precede additions; changed clients are remove+add"
        );
        let added = patch
            .vpn_portal_clients
            .iter()
            .filter(|item| item.action == ConfigPatchAction::Add as i32)
            .filter_map(|item| item.client.as_ref())
            .map(|client| client.virtual_ip.as_str())
            .collect::<Vec<_>>();
        assert_eq!(added, ["10.144.144.5/24", "10.144.144.7/24"]);
    }

    #[test]
    fn vpn_portal_client_no_op_produces_empty_patch_section() {
        let current = config_with_vpn_portal(
            vec![portal_client("alice", "10.144.144.4/24")],
            "0.0.0.0:22121",
        );
        let desired = config_with_vpn_portal(
            vec![portal_client("alice", "10.144.144.4/24")],
            "0.0.0.0:22121",
        );

        let patch = web_source_runtime_patch(&current, &desired)
            .unwrap()
            .unwrap();
        assert!(patch.vpn_portal_clients.is_empty());
    }

    #[test]
    fn vpn_portal_listener_identity_change_requires_recreate() {
        let current = config_with_vpn_portal(
            vec![portal_client("alice", "10.144.144.4/24")],
            "0.0.0.0:22121",
        );
        let desired = config_with_vpn_portal(
            vec![portal_client("alice", "10.144.144.4/24")],
            "0.0.0.0:22122",
        );
        assert!(
            web_source_runtime_patch(&current, &desired)
                .unwrap()
                .is_none()
        );

        let mut different_key = desired.clone();
        different_key
            .vpn_portal_config
            .as_mut()
            .unwrap()
            .wireguard_listen = "0.0.0.0:22121".to_owned();
        different_key
            .vpn_portal_config
            .as_mut()
            .unwrap()
            .wireguard_private_key = Some("bm90LXRoZS1zYW1lLWtleQ==".to_owned());
        assert!(
            web_source_runtime_patch(&current, &different_key)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn vpn_portal_enable_or_disable_requires_recreate() {
        let without_portal = config_with_port_forwards(Vec::new());
        let with_portal = config_with_vpn_portal(
            vec![portal_client("alice", "10.144.144.4/24")],
            "0.0.0.0:22121",
        );

        assert!(
            web_source_runtime_patch(&without_portal, &with_portal)
                .unwrap()
                .is_none()
        );
        assert!(
            web_source_runtime_patch(&with_portal, &without_portal)
                .unwrap()
                .is_none()
        );

        let mut disabled = with_portal.clone();
        disabled.vpn_portal_config.as_mut().unwrap().enabled = Some(false);
        assert!(
            web_source_runtime_patch(&with_portal, &disabled)
                .unwrap()
                .is_none()
        );
        assert!(
            web_source_runtime_patch(&disabled, &with_portal)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            web_source_runtime_patch(&disabled, &disabled).unwrap(),
            Some(InstanceConfigPatch::default())
        );
        let mut edited = disabled.clone();
        edited.vpn_portal_config.as_mut().unwrap().clients.clear();
        assert!(
            web_source_runtime_patch(&disabled, &edited)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn runtime_patch_ignores_runtime_defaults_and_adds_port_forward() {
        let mut current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        current.virtual_ipv4 = Some("10.144.0.2".to_string());
        current.network_length = Some(16);
        current.bind_device = Some(true);
        current.dev_name = Some(String::new());
        current.disable_ipv6 = Some(false);
        current.mtu = Some(1380);
        current.multi_thread = Some(true);

        let desired =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23007, 3389)]);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.port_forwards.len(), 1);
        assert_eq!(
            patch_port(&patch.port_forwards[0]),
            (
                ConfigPatchAction::Add as i32,
                23007,
                3389,
                SocketType::Tcp as i32
            )
        );
    }

    #[test]
    fn runtime_patch_removes_deleted_port_forward_without_clear() {
        let current =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23007, 3389)]);
        let desired = config_with_port_forwards(vec![port_forward(23000, 5174)]);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.port_forwards.len(), 1);
        assert_eq!(
            patch_port(&patch.port_forwards[0]),
            (
                ConfigPatchAction::Remove as i32,
                23007,
                3389,
                SocketType::Tcp as i32
            )
        );
    }

    #[test]
    fn runtime_patch_reconciles_duplicate_port_forward_count() {
        let current =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23000, 5174)]);
        let desired = config_with_port_forwards(vec![port_forward(23000, 5174)]);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.port_forwards.len(), 2);
        assert_eq!(
            patch_port(&patch.port_forwards[0]),
            (
                ConfigPatchAction::Remove as i32,
                23000,
                5174,
                SocketType::Tcp as i32
            )
        );
        assert_eq!(
            patch_port(&patch.port_forwards[1]),
            (
                ConfigPatchAction::Add as i32,
                23000,
                5174,
                SocketType::Tcp as i32
            )
        );
    }

    #[test]
    fn runtime_reconcile_ignores_automatic_device_name_when_unmanaged() {
        let mut current = config_with_port_forwards(Vec::new());
        current.dev_name = Some("et_3_abcd".to_string());
        let desired = config_with_port_forwards(Vec::new());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");

        assert!(matches!(action, RuntimeReconcileAction::Unchanged(_)));
    }

    #[test]
    fn runtime_reconcile_ignores_automatic_device_name_for_empty_desired_name() {
        let mut current = config_with_port_forwards(Vec::new());
        current.dev_name = Some("et_3_abcd".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.dev_name = Some(String::new());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");

        assert!(matches!(action, RuntimeReconcileAction::Unchanged(_)));
    }

    #[test]
    fn runtime_reconcile_clears_explicit_device_name() {
        let mut current = config_with_port_forwards(Vec::new());
        current.dev_name = Some("managed-device".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.dev_name = Some(String::new());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");
        let RuntimeReconcileAction::Run { overwrite, .. } = action else {
            panic!("clearing an explicit device name should require a full overwrite");
        };

        assert!(overwrite);
    }

    #[test]
    fn runtime_reconcile_applies_explicit_device_name() {
        let mut current = config_with_port_forwards(Vec::new());
        current.dev_name = Some("et_3_abcd".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.dev_name = Some("managed-device".to_string());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");
        let RuntimeReconcileAction::Run { overwrite, .. } = action else {
            panic!("explicit device name should require a full overwrite");
        };

        assert!(overwrite);
    }

    #[test]
    fn runtime_convergence_rejects_stale_extra_port_forward() {
        let current = config_with_port_forwards(vec![
            port_forward(23000, 5174),
            port_forward(23007, 3389),
            port_forward(23100, 8080),
        ]);
        let desired =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23007, 3389)]);

        let err = ensure_runtime_config_converged(&current, &desired, false)
            .expect_err("extra runtime port forward should not converge");

        assert!(
            err.to_string()
                .contains("runtime config still needs patch after reconcile"),
            "unexpected error: {err:?}"
        );
    }

    #[test]
    fn runtime_patch_canonicalizes_port_forward_protocol() {
        let current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        let mut desired_port_forward = port_forward(23000, 5174);
        desired_port_forward.proto = "TCP".to_string();
        let desired = config_with_port_forwards(vec![desired_port_forward]);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch, InstanceConfigPatch::default());
        ensure_runtime_config_converged(&current, &desired, false).expect("runtime converged");
    }

    #[test]
    fn runtime_patch_rejects_non_hot_config_change() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();

        desired.network_secret = Some("new-secret".to_string());

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn full_overwrite_preserves_unmanaged_hostname_for_later_explicit_clear() {
        let mut current = config_with_port_forwards(Vec::new());
        current.hostname = Some("runtime-host".to_string());
        let mut unmanaged_desired = current.clone();
        unmanaged_desired.hostname = None;
        unmanaged_desired.network_secret = Some("new-secret".to_string());

        let action =
            prepare_web_source_runtime_reconcile_from_current(&current, unmanaged_desired.clone())
                .expect("prepare full overwrite");
        let RuntimeReconcileAction::Run { config, overwrite } = action else {
            panic!("non-hot change should require a full overwrite");
        };
        assert!(overwrite);
        assert_eq!(config.hostname.as_deref(), Some("runtime-host"));

        let observed_after_run = *config;
        let mut explicit_clear = unmanaged_desired;
        explicit_clear.hostname = Some(String::new());
        let action =
            prepare_web_source_runtime_reconcile_from_current(&observed_after_run, explicit_clear)
                .expect("prepare explicit clear");
        let RuntimeReconcileAction::Patch(patch) = action else {
            panic!("explicit clear should patch the preserved runtime hostname");
        };

        assert_eq!(patch.hostname.as_deref(), Some(""));
    }

    #[test]
    fn runtime_patch_replaces_managed_credentials_without_full_run() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();
        desired.managed_credentials = vec![ManagedCredentialConfig {
            credential_id: "managed".to_owned(),
            credential_secret: "credential-secret".to_owned(),
            expiry_unix: 2_000_000_000,
            ..Default::default()
        }];

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");
        let RuntimeReconcileAction::Patch(patch) = action else {
            panic!("managed credential change must use a hot patch");
        };
        let managed = patch.managed_credentials.expect("managed credential patch");
        assert_eq!(managed.entries.len(), 1);
        assert_eq!(managed.entries[0].credential_id, "managed");
    }

    #[test]
    fn runtime_patch_rejects_routes_change() {
        let mut current = config_with_port_forwards(Vec::new());
        current.enable_manual_routes = Some(true);
        current.routes = vec!["10.1.0.0/16".to_string(), "10.2.0.0/16".to_string()];
        let mut desired = config_with_port_forwards(Vec::new());
        desired.enable_manual_routes = Some(true);
        desired.routes = vec!["10.2.0.0/16".to_string(), "10.3.0.0/16".to_string()];

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_replaces_proxy_networks() {
        let mut current = config_with_port_forwards(Vec::new());
        current.proxy_cidrs = vec![
            "10.1.0.0/16".to_string(),
            "10.2.0.0/16->10.20.0.0/16".to_string(),
        ];
        let mut desired = config_with_port_forwards(Vec::new());
        desired.proxy_cidrs = vec![
            "10.2.0.0/16->10.21.0.0/16".to_string(),
            "10.3.0.0/16".to_string(),
        ];

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.proxy_networks.len(), 3);
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[0]),
            (
                ConfigPatchAction::Clear as i32,
                "10.2.0.0/16".to_string(),
                None
            )
        );
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[1]),
            (
                ConfigPatchAction::Add as i32,
                "10.2.0.0/16".to_string(),
                Some("10.21.0.0/16".to_string())
            )
        );
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[2]),
            (
                ConfigPatchAction::Add as i32,
                "10.3.0.0/16".to_string(),
                None
            )
        );
    }

    #[test]
    fn runtime_patch_replaces_proxy_networks_with_same_source_cidr() {
        let mut current = config_with_port_forwards(Vec::new());
        current.proxy_cidrs = vec![
            "10.1.2.0/24".to_string(),
            "10.1.2.0/24->10.1.3.0/24".to_string(),
        ];
        let mut desired = config_with_port_forwards(Vec::new());
        desired.proxy_cidrs = vec!["10.1.2.0/24->10.1.3.0/24".to_string()];

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.proxy_networks.len(), 2);
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[0]),
            (
                ConfigPatchAction::Clear as i32,
                "10.1.2.0/24".to_string(),
                None
            )
        );
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[1]),
            (
                ConfigPatchAction::Add as i32,
                "10.1.2.0/24".to_string(),
                Some("10.1.3.0/24".to_string())
            )
        );
    }

    #[test]
    fn runtime_patch_rejects_proxy_network_empty_to_nonempty() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.proxy_cidrs = vec!["10.1.2.0/24".to_string()];

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_clears_proxy_networks_with_legacy_compatible_cidr() {
        let mut current = config_with_port_forwards(Vec::new());
        current.proxy_cidrs = vec!["10.1.2.0/24".to_string()];
        let desired = config_with_port_forwards(Vec::new());

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.proxy_networks.len(), 1);
        assert_eq!(
            patch_proxy_network(&patch.proxy_networks[0]),
            (
                ConfigPatchAction::Clear as i32,
                "10.1.2.0/24".to_string(),
                None
            )
        );
    }

    #[test]
    fn runtime_patch_updates_disable_relay_data() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();
        desired.disable_relay_data = Some(true);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.disable_relay_data, Some(true));
    }

    #[test]
    fn runtime_patch_updates_peer_relay_preference_independently() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();
        desired.prefer_peer_relay = Some(true);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.prefer_peer_relay, Some(true));
        assert_eq!(patch.disable_relay_data, None);
    }

    #[test]
    fn runtime_patch_still_rejects_unsupported_flag_change() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = current.clone();
        desired.no_tun = Some(true);

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_rejects_encryption_algorithm_change() {
        let mut current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        current.encryption_algorithm = Some("aes-gcm".to_string());
        let mut desired = current.clone();
        desired.encryption_algorithm = Some("chacha20".to_string());

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_rejects_invalid_encryption_algorithm_before_diffing() {
        let current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        let mut desired = current.clone();
        desired.encryption_algorithm = Some("managed-test-algo".to_string());

        let error = web_source_runtime_patch(&current, &desired)
            .expect_err("unknown encryption algorithms must fail validation");

        assert!(error.to_string().contains("invalid encryption_algorithm"));
    }

    #[test]
    fn runtime_patch_rejects_data_compress_algo_change() {
        let current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        let mut desired = current.clone();
        desired.data_compress_algo = Some(CompressionAlgoPb::Zstd as i32);

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_rejects_credential_private_key_change() {
        let mut current = config_with_port_forwards(Vec::new());
        current.network_secret = None;
        current.secure_mode = Some(easytier::proto::common::SecureModeConfig {
            enabled: true,
            local_private_key: Some("mUuD5fsIm/ftvgS4WBAYFMNLqWX3qT9rnm4PrnOqb9s=".to_string()),
            local_public_key: None,
        });
        let mut desired = current.clone();
        desired.secure_mode = Some(easytier::proto::common::SecureModeConfig {
            enabled: true,
            local_private_key: Some("aEpz80FuYbaY4QLJizAIuIcK4TYsoSA9jHHCXCOQJoc=".to_string()),
            local_public_key: None,
        });

        let patch = web_source_runtime_patch(&current, &desired).expect("build patch");

        assert!(patch.is_none());
    }

    #[test]
    fn runtime_patch_ignores_generated_secure_key_when_network_secret_exists() {
        let mut current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        current.secure_mode = Some(easytier::proto::common::SecureModeConfig {
            enabled: true,
            local_private_key: Some("mUuD5fsIm/ftvgS4WBAYFMNLqWX3qT9rnm4PrnOqb9s=".to_string()),
            local_public_key: Some("4x6L5dZjB8hsPO4f96Hyhi4xFealBu6i3BxRVBYR1Fc=".to_string()),
        });
        let mut desired =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23007, 3389)]);
        desired.secure_mode = Some(easytier::proto::common::SecureModeConfig {
            enabled: true,
            local_private_key: None,
            local_public_key: None,
        });

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.port_forwards.len(), 1);
        assert_eq!(
            patch_port(&patch.port_forwards[0]),
            (
                ConfigPatchAction::Add as i32,
                23007,
                3389,
                SocketType::Tcp as i32
            )
        );
    }

    #[test]
    fn runtime_patch_ignores_runtime_hostname_when_desired_omits_hostname() {
        let mut current = config_with_port_forwards(vec![port_forward(23000, 5174)]);
        current.hostname = Some("runtime-host".to_string());
        let desired =
            config_with_port_forwards(vec![port_forward(23000, 5174), port_forward(23007, 3389)]);

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.port_forwards.len(), 1);
        assert_eq!(
            patch_port(&patch.port_forwards[0]),
            (
                ConfigPatchAction::Add as i32,
                23007,
                3389,
                SocketType::Tcp as i32
            )
        );
    }

    #[test]
    fn runtime_reconcile_hot_patches_explicit_desired_hostname_change() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("desired-host".to_string());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");
        let RuntimeReconcileAction::Patch(patch) = action else {
            panic!("hostname-only change should use a hot patch");
        };

        assert_eq!(patch.hostname.as_deref(), Some("desired-host"));
    }

    #[test]
    fn runtime_convergence_accepts_hostname_only_readback_difference() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("device-host".to_string());

        ensure_runtime_config_converged(&current, &desired, true)
            .expect("hostname-only readback difference should be converged");
    }

    #[test]
    fn runtime_convergence_rejects_omitted_hostname_before_apply() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("device-host".to_string());

        let err = ensure_runtime_config_converged(&current, &desired, false)
            .expect_err("omitted hostname before apply should not converge");

        assert!(
            err.to_string()
                .contains("runtime config still needs patch after reconcile")
        );
    }

    #[test]
    fn runtime_convergence_rejects_explicit_wrong_hostname_after_apply() {
        let mut current = config_with_port_forwards(Vec::new());
        current.hostname = Some("wrong-host".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("device-host".to_string());

        let err = ensure_runtime_config_converged(&current, &desired, true)
            .expect_err("explicit wrong hostname should not converge");

        assert!(
            err.to_string()
                .contains("runtime config still needs patch after reconcile")
        );
    }

    #[test]
    fn runtime_patch_clears_explicit_desired_hostname() {
        let mut current = config_with_port_forwards(Vec::new());
        current.hostname = Some("runtime-host".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some(String::new());

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.hostname.as_deref(), Some(""));
    }

    #[test]
    fn runtime_patch_normalizes_missing_runtime_hostname_for_explicit_clear() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some(String::new());

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");

        assert!(matches!(action, RuntimeReconcileAction::Unchanged(_)));
    }

    #[test]
    fn runtime_patch_skips_matching_explicit_hostname() {
        let mut current = config_with_port_forwards(Vec::new());
        current.hostname = Some("desired-host".to_string());
        let desired = current.clone();

        let action = prepare_web_source_runtime_reconcile_from_current(&current, desired)
            .expect("prepare reconcile");

        assert!(matches!(action, RuntimeReconcileAction::Unchanged(_)));
    }

    #[test]
    fn runtime_patch_uses_core_normalized_hostname() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("a".repeat(33));

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.hostname.as_deref(), Some("a".repeat(32).as_str()));
    }

    #[test]
    fn runtime_patch_removes_hostname_control_characters() {
        let current = config_with_port_forwards(Vec::new());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("node\u{7}-name".to_string());

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.hostname.as_deref(), Some("node-name"));
    }

    #[test]
    fn runtime_patch_normalizes_control_only_hostname_to_clear() {
        let mut current = config_with_port_forwards(Vec::new());
        current.hostname = Some("runtime-host".to_string());
        let mut desired = config_with_port_forwards(Vec::new());
        desired.hostname = Some("\u{7}\n".to_string());

        let patch = web_source_runtime_patch(&current, &desired)
            .expect("build patch")
            .expect("hot patch");

        assert_eq!(patch.hostname.as_deref(), Some(""));
    }
}
