use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

use easytier::common::config::{Flags, NetworkConfig};
use easytier::proto::common::CompressionAlgoPb;
use easytier::tunnel::IpScheme;
use easytier_core::config::EncryptionAlgorithm;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NetworkTransportSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_compress_algo: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_kcp_proxy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_kcp_input: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enable_quic_proxy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_quic_input: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_encryption: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tld_dns_zone: Option<String>,
}

impl NetworkTransportSettings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.data_compress_algo.is_some_and(|algorithm| {
            algorithm != CompressionAlgoPb::None as i32
                && algorithm != CompressionAlgoPb::Zstd as i32
        }) {
            return Err("data_compress_algo must be 1 (None) or 2 (Zstd)".to_owned());
        }
        if let Some(algorithm) = &self.encryption_algorithm {
            algorithm
                .parse::<EncryptionAlgorithm>()
                .map_err(|_| "invalid encryption_algorithm".to_owned())?;
        }
        if let Some(protocol) = &self.default_protocol {
            protocol
                .parse::<IpScheme>()
                .map_err(|_| "invalid default_protocol".to_owned())?;
        }
        if let Some(zone) = &self.tld_dns_zone {
            let name = zone.strip_suffix('.').unwrap_or(zone);
            if !name.is_ascii()
                || name.is_empty()
                || name.len() > 253
                || !name.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label.as_bytes()[0].is_ascii_alphanumeric()
                        && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
            {
                return Err("tld_dns_zone must be a valid ASCII domain name".to_owned());
            }
        }
        Ok(())
    }

    pub(crate) fn apply_to_config(&self, config: &mut NetworkConfig) {
        if let Some(value) = self.data_compress_algo {
            config.data_compress_algo = Some(value);
        }
        if let Some(value) = self.enable_kcp_proxy {
            config.enable_kcp_proxy = Some(value);
        }
        if let Some(value) = self.disable_kcp_input {
            config.disable_kcp_input = Some(value);
        }
        if let Some(value) = self.enable_quic_proxy {
            config.enable_quic_proxy = Some(value);
        }
        if let Some(value) = self.disable_quic_input {
            config.disable_quic_input = Some(value);
        }
        if let Some(value) = &self.encryption_algorithm {
            config.encryption_algorithm = Some(value.clone());
        }
        if let Some(value) = self.disable_encryption {
            config.disable_encryption = Some(value);
        }
        if let Some(value) = &self.default_protocol {
            config.default_protocol = Some(value.clone());
        }
        if let Some(value) = &self.tld_dns_zone {
            config.tld_dns_zone = Some(value.clone());
        }
    }

    pub(crate) fn apply_to_flags(&self, flags: &mut Flags) {
        if let Some(value) = self.data_compress_algo {
            flags.data_compress_algo = value;
        }
        if let Some(value) = self.enable_kcp_proxy {
            flags.enable_kcp_proxy = value;
        }
        if let Some(value) = self.disable_kcp_input {
            flags.disable_kcp_input = value;
        }
        if let Some(value) = self.enable_quic_proxy {
            flags.enable_quic_proxy = value;
        }
        if let Some(value) = self.disable_quic_input {
            flags.disable_quic_input = value;
        }
        if let Some(value) = &self.encryption_algorithm {
            flags.encryption_algorithm = value.clone();
        }
        if let Some(value) = self.disable_encryption {
            flags.enable_encryption = !value;
        }
        if let Some(value) = &self.default_protocol {
            flags.default_protocol = value.clone();
        }
        if let Some(value) = &self.tld_dns_zone {
            flags.tld_dns_zone = value.clone();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CentralNetworkIntent {
    pub id: Uuid,
    pub user_id: i32,
    pub display_name: String,
    pub network_name: String,
    pub network_secret: String,
    pub mode: NetworkMode,
    pub virtual_cidr: Option<String>,
    pub secure_mode: bool,
    #[serde(default)]
    pub prefer_ipv6: bool,
    #[serde(default)]
    pub transport: NetworkTransportSettings,
    pub members: Vec<NetworkMemberIntent>,
    pub credentials: Vec<NetworkCredentialIntent>,
    pub acl_policy: Option<AclPolicy>,
}

impl CentralNetworkIntent {
    pub fn remove_device(&mut self, device_id: Uuid) -> bool {
        let removed_members: Vec<_> = self
            .members
            .iter()
            .filter(|member| member.device_id == device_id.to_string())
            .cloned()
            .collect();
        if removed_members.is_empty() {
            return false;
        }
        let removed_member_ids: HashSet<_> =
            removed_members.iter().map(|member| member.id).collect();
        let removed_credential_ids: HashSet<_> = removed_members
            .iter()
            .filter_map(|member| member.credential_id.as_deref())
            .collect();
        let removed_groups: HashSet<_> = self
            .credentials
            .iter()
            .filter(|credential| removed_credential_ids.contains(credential.id.as_str()))
            .flat_map(|credential| credential.grant.acl_groups.iter().cloned())
            .collect();

        self.members
            .retain(|member| !removed_member_ids.contains(&member.id));
        self.credentials
            .retain(|credential| !removed_credential_ids.contains(credential.id.as_str()));
        let remaining_groups: HashSet<_> = self
            .credentials
            .iter()
            .flat_map(|credential| credential.grant.acl_groups.iter().cloned())
            .collect();
        let removed_groups: HashSet<_> = removed_groups
            .difference(&remaining_groups)
            .cloned()
            .collect();

        if let Some(policy) = &mut self.acl_policy {
            policy.rules.retain_mut(|rule| {
                rule.sources.retain(|source| match source {
                    AclSource::Member { member_id } => !removed_member_ids.contains(member_id),
                    AclSource::Group { name } => !removed_groups.contains(name),
                    AclSource::All => true,
                });
                rule.destinations.retain(|destination| match destination {
                    AclDestination::Member { member_id }
                    | AclDestination::Subnet { member_id, .. } => {
                        !removed_member_ids.contains(member_id)
                    }
                    AclDestination::All => true,
                });
                !rule.sources.is_empty() && !rule.destinations.is_empty()
            });
        }
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NetworkMode {
    PublicServer { url: String },
    Manual { peer_urls: Vec<String> },
    Standalone,
    Gateway { peer_url: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NetworkMemberIntent {
    pub id: Uuid,
    pub device_id: String,
    pub hostname: Option<String>,
    pub virtual_ipv4: Option<String>,
    #[serde(default)]
    pub allocated_ipv4: Option<String>,
    #[serde(default)]
    pub config_override: Option<NetworkConfig>,
    pub credential_id: Option<String>,
    /// HMAC material for permanent administrator group proofs. Temporary
    /// members authenticate their groups through their credential grant and
    /// must leave this empty.
    pub acl_group_secret: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkCredentialIntent {
    pub id: String,
    pub secret: String,
    pub expiry_unix: i64,
    pub grant: CredentialGrant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialGrant {
    pub acl_groups: Vec<String>,
    pub allow_relay: bool,
    pub allowed_proxy_cidrs: Vec<String>,
    pub reusable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AclPolicy {
    pub default_action: AclAction,
    pub rules: Vec<AclRule>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclAction {
    #[default]
    Allow,
    Deny,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AclRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub action: AclAction,
    pub sources: Vec<AclSource>,
    pub destinations: Vec<AclDestination>,
    pub protocols: Vec<AclProtocolTarget>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AclSource {
    All,
    Member { member_id: Uuid },
    Group { name: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AclDestination {
    All,
    Member { member_id: Uuid },
    Subnet { member_id: Uuid, cidrs: Vec<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AclProtocol {
    Tcp,
    Udp,
    Icmp,
    Icmpv6,
    Any,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AclProtocolTarget {
    pub protocol: AclProtocol,
    pub ports: Vec<String>,
    pub stateful: bool,
}

pub fn member_group_name(member_id: Uuid) -> String {
    format!("member:{member_id}")
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    #[test]
    fn transport_json_is_optional_and_rejects_unknown_fields() {
        let inherited: NetworkTransportSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(inherited, NetworkTransportSettings::default());
        assert_eq!(serde_json::to_string(&inherited).unwrap(), "{}");
        assert!(serde_json::from_str::<NetworkTransportSettings>(r#"{"mtu":1300}"#).is_err());
        assert!(
            serde_json::from_str::<NetworkTransportSettings>(r#"{"enable_kcp_proxy":"false"}"#)
                .is_err()
        );
        for algorithm in [-1, 0, 3, 99] {
            assert!(
                NetworkTransportSettings {
                    data_compress_algo: Some(algorithm),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
        for algorithm in [1, 2] {
            assert!(
                NetworkTransportSettings {
                    data_compress_algo: Some(algorithm),
                    ..Default::default()
                }
                .validate()
                .is_ok()
            );
        }
    }

    #[test]
    fn config_and_gateway_flags_share_explicit_transport_values() {
        let policy = NetworkTransportSettings {
            data_compress_algo: Some(2),
            enable_kcp_proxy: Some(false),
            disable_kcp_input: Some(false),
            enable_quic_proxy: Some(true),
            disable_quic_input: Some(true),
            encryption_algorithm: Some("aes-256-gcm".to_owned()),
            disable_encryption: Some(false),
            default_protocol: Some("udp".to_owned()),
            tld_dns_zone: Some("mesh.example.".to_owned()),
        };
        let mut config = NetworkConfig {
            mtu: Some(1300),
            enable_kcp_proxy: Some(true),
            disable_kcp_input: Some(true),
            encryption_algorithm: Some("xor".to_owned()),
            disable_encryption: Some(true),
            ..Default::default()
        };
        let mut flags = Flags {
            mtu: 1300,
            enable_kcp_proxy: true,
            disable_kcp_input: true,
            encryption_algorithm: "xor".to_owned(),
            enable_encryption: false,
            ..Default::default()
        };
        policy.apply_to_config(&mut config);
        policy.apply_to_flags(&mut flags);
        assert_eq!(config.data_compress_algo, Some(flags.data_compress_algo));
        assert_eq!(config.enable_kcp_proxy, Some(flags.enable_kcp_proxy));
        assert_eq!(config.disable_kcp_input, Some(flags.disable_kcp_input));
        assert_eq!(config.enable_quic_proxy, Some(flags.enable_quic_proxy));
        assert_eq!(config.disable_quic_input, Some(flags.disable_quic_input));
        assert_eq!(
            config.encryption_algorithm,
            Some(flags.encryption_algorithm)
        );
        assert_eq!(config.disable_encryption, Some(!flags.enable_encryption));
        assert_eq!(config.default_protocol, Some(flags.default_protocol));
        assert_eq!(config.tld_dns_zone, Some(flags.tld_dns_zone));
        assert_eq!(config.mtu, Some(1300));
        assert_eq!(flags.mtu, 1300);
    }

    #[test]
    fn network_transport_validates_core_algorithms_protocols_and_dns_names() {
        for algorithm in [
            "xor",
            "aes-gcm",
            "aes-256-gcm",
            "chacha20",
            "openssl-aes-gcm",
        ] {
            assert!(
                NetworkTransportSettings {
                    encryption_algorithm: Some(algorithm.to_owned()),
                    ..Default::default()
                }
                .validate()
                .is_ok()
            );
        }
        for protocol in ["tcp", "udp"] {
            assert!(
                NetworkTransportSettings {
                    default_protocol: Some(protocol.to_owned()),
                    ..Default::default()
                }
                .validate()
                .is_ok()
            );
        }
        for zone in ["et.net.", "mesh.example", "MESH.example.", "vpn-1", "a"] {
            assert!(
                NetworkTransportSettings {
                    tld_dns_zone: Some(zone.to_owned()),
                    ..Default::default()
                }
                .validate()
                .is_ok()
            );
        }
        let mut invalid = vec![
            "".to_owned(),
            ".".to_owned(),
            "mesh..example".to_owned(),
            "-mesh.example".to_owned(),
            "mesh-.example".to_owned(),
            "mesh_example".to_owned(),
            "mesh.example..".to_owned(),
            " mesh.example".to_owned(),
            "内网.example".to_owned(),
            "mesh.example\n".to_owned(),
            format!("{}.example", "a".repeat(64)),
        ];
        invalid.push(format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(63)
        ));
        for zone in invalid {
            assert!(
                NetworkTransportSettings {
                    tld_dns_zone: Some(zone),
                    ..Default::default()
                }
                .validate()
                .is_err()
            );
        }
        for policy in [
            NetworkTransportSettings {
                encryption_algorithm: Some("invalid".to_owned()),
                ..Default::default()
            },
            NetworkTransportSettings {
                default_protocol: Some("https".to_owned()),
                ..Default::default()
            },
            NetworkTransportSettings {
                default_protocol: Some("".to_owned()),
                ..Default::default()
            },
        ] {
            assert!(policy.validate().is_err());
        }
    }
}
