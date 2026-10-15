//! Conversion between the management NetworkConfig schema and shared TOML.

use std::net::SocketAddr;

use anyhow::Context;
use easytier_proto::api::manage;

use crate::config::{
    MappedListenerPolicy, normalize_secure_mode_config,
    toml::{
        ConfigLoader, ManagedCredentialConfig, NetworkIdentity, PeerConfig, PortForwardConfig,
        TomlConfigLoader, VpnPortalClientConfig, VpnPortalConfig, gen_default_flags,
    },
};

fn parse_mapped_listener_urls(mapped_listeners: &[String]) -> Result<Vec<url::Url>, anyhow::Error> {
    MappedListenerPolicy::new(["tcp", "udp", "wg", "quic", "ws", "wss", "faketcp"])
        .parse_urls(mapped_listeners)
}

pub fn add_proxy_network_to_config(
    proxy_network: &str,
    cfg: &TomlConfigLoader,
) -> Result<(), anyhow::Error> {
    let parts: Vec<&str> = proxy_network.split("->").collect();
    let real_cidr = parts[0]
        .parse()
        .with_context(|| format!("failed to parse proxy network: {}", parts[0]))?;

    if parts.len() > 2 {
        return Err(anyhow::anyhow!(
                    "invalid proxy network format: {}, support format: <real_cidr> or <real_cidr>-><mapped_cidr>, example:
                    10.0.0.0/24 or 10.0.0.0/24->192.168.0.0/24",
                    proxy_network
                ));
    }

    let mapped_cidr = if parts.len() == 2 {
        Some(
            parts[1]
                .parse()
                .with_context(|| format!("failed to parse mapped network: {}", parts[1]))?,
        )
    } else {
        None
    };
    cfg.add_proxy_cidr(real_cidr, mapped_cidr)?;
    Ok(())
}

pub type NetworkingMethod = easytier_proto::api::manage::NetworkingMethod;
pub type NetworkConfig = easytier_proto::api::manage::NetworkConfig;

pub(crate) fn managed_credential_from_proto(
    credential: &manage::ManagedCredentialConfig,
) -> ManagedCredentialConfig {
    ManagedCredentialConfig {
        credential_id: credential.credential_id.clone(),
        credential_secret: credential.credential_secret.clone(),
        groups: credential.groups.clone(),
        allow_relay: credential.allow_relay,
        allowed_proxy_cidrs: credential.allowed_proxy_cidrs.clone(),
        expiry_unix: credential.expiry_unix,
        reusable: credential.reusable.unwrap_or(true),
    }
}

pub(crate) fn managed_credential_to_proto(
    credential: ManagedCredentialConfig,
) -> manage::ManagedCredentialConfig {
    manage::ManagedCredentialConfig {
        credential_id: credential.credential_id,
        credential_secret: credential.credential_secret,
        groups: credential.groups,
        allow_relay: credential.allow_relay,
        allowed_proxy_cidrs: credential.allowed_proxy_cidrs,
        expiry_unix: credential.expiry_unix,
        reusable: Some(credential.reusable),
    }
}

pub trait NetworkConfigExt {
    fn gen_config(&self) -> Result<TomlConfigLoader, anyhow::Error>;
    fn new_from_config(config: impl ConfigLoader) -> Result<NetworkConfig, anyhow::Error>;
}

#[cfg(all(
    feature = "browser-config",
    any(test, all(target_arch = "wasm32", target_os = "unknown"))
))]
const FORM_MANAGED_TOML_FIELDS: &[&str] = &[
    "hostname",
    "instance_name",
    "instance_id",
    "ipv4",
    "ipv6",
    "netns",
    "ipv6_public_addr_provider",
    "ipv6_public_addr_auto",
    "ipv6_public_addr_prefix",
    "dhcp",
    "network_identity",
    "listeners",
    "mapped_listeners",
    "exit_nodes",
    "peer",
    "proxy_network",
    "vpn_portal_config",
    "routes",
    "socks5_proxy",
    "port_forward",
    "secure_mode",
    "acl",
    "credential_file",
    "managed_credentials",
    "uplink",
    "stun_servers",
    "tcp_stun_servers",
    "stun_servers_v6",
    "tcp_whitelist",
    "udp_whitelist",
];

#[cfg(all(
    feature = "browser-config",
    any(test, all(target_arch = "wasm32", target_os = "unknown"))
))]
const FORM_MANAGED_FLAG_FIELDS: &[&str] = &[
    "default_protocol",
    "latency_first",
    "dev_name",
    "use_smoltcp",
    "enable_ipv6",
    "prefer_ipv6",
    "enable_kcp_proxy",
    "disable_kcp_input",
    "enable_quic_proxy",
    "disable_quic_input",
    "disable_relay_kcp",
    "disable_relay_quic",
    "enable_relay_foreign_network_kcp",
    "enable_relay_foreign_network_quic",
    "foreign_relay_bps_limit",
    "tld_dns_zone",
    "disable_p2p",
    "p2p_only",
    "lazy_p2p",
    "bind_device",
    "socket_mark",
    "no_tun",
    "enable_exit_node",
    "relay_all_peer_rpc",
    "need_p2p",
    "multi_thread",
    "proxy_forward_by_system",
    "enable_encryption",
    "relay_network_whitelist",
    "disable_tcp_hole_punching",
    "disable_udp_hole_punching",
    "disable_upnp",
    "disable_relay_data",
    "prefer_peer_relay",
    "enable_udp_broadcast_relay",
    "disable_sym_hole_punching",
    "accept_dns",
    "mtu",
    "instance_recv_bps_limit",
    "private_mode",
    "encryption_algorithm",
    "data_compress_algo",
];

#[cfg(all(
    feature = "browser-config",
    any(test, all(target_arch = "wasm32", target_os = "unknown"))
))]
pub(crate) fn merge_network_config_toml(
    original_toml: &str,
    config: &NetworkConfig,
) -> Result<String, anyhow::Error> {
    let generated_toml = config.gen_config()?.dump();
    let mut original = toml::from_str::<toml::Table>(original_toml)
        .context("failed to parse the original TOML document")?;
    let mut generated = toml::from_str::<toml::Table>(&generated_toml)
        .context("failed to parse the generated TOML document")?;

    for (key, value) in original.iter() {
        if key != "flags" && !FORM_MANAGED_TOML_FIELDS.contains(&key.as_str()) {
            generated.insert(key.clone(), value.clone());
        }
    }
    if config.instance_name.is_none() && !original.contains_key("instance_name") {
        generated.remove("instance_name");
    }

    let mut merged_flags: toml::Table = original
        .remove("flags")
        .and_then(|value| value.try_into().ok())
        .unwrap_or_default();
    let generated_flags: toml::Table = generated
        .remove("flags")
        .and_then(|value| value.try_into().ok())
        .unwrap_or_default();
    for key in FORM_MANAGED_FLAG_FIELDS {
        if let Some(value) = generated_flags.get(*key) {
            merged_flags.insert((*key).to_owned(), value.clone());
        } else {
            merged_flags.remove(*key);
        }
    }
    if !merged_flags.is_empty() {
        generated.insert("flags".to_owned(), toml::Value::Table(merged_flags));
    }

    toml::to_string_pretty(&generated).context("failed to serialize the merged TOML document")
}

fn parse_peer(peer: &manage::NetworkPeerConfig) -> Result<Option<PeerConfig>, anyhow::Error> {
    let uri = peer.uri.trim();
    if uri.is_empty() {
        return Ok(None);
    }

    Ok(Some(PeerConfig {
        uri: uri
            .parse()
            .with_context(|| format!("failed to parse peer uri: {}", uri))?,
        peer_public_key: peer.peer_public_key.clone(),
    }))
}

fn parse_peers(peers: &[manage::NetworkPeerConfig]) -> Result<Vec<PeerConfig>, anyhow::Error> {
    let mut ret = Vec::new();
    for peer in peers {
        if let Some(peer) = parse_peer(peer)? {
            ret.push(peer);
        }
    }
    Ok(ret)
}

fn parse_peer_urls(peer_urls: &[String]) -> Result<Vec<PeerConfig>, anyhow::Error> {
    let mut peers = vec![];
    for peer_url in peer_urls.iter() {
        let peer_url = peer_url.trim();
        if peer_url.is_empty() {
            continue;
        }
        peers.push(PeerConfig {
            uri: peer_url
                .parse()
                .with_context(|| format!("failed to parse peer uri: {}", peer_url))?,
            peer_public_key: None,
        });
    }
    Ok(peers)
}

fn valid_dns_name(value: &str) -> bool {
    let name = value.strip_suffix('.').unwrap_or(value);
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn validate_stun_servers(servers: &manage::ConfigStringList, field: &str) -> anyhow::Result<()> {
    for server in &servers.values {
        let valid = if let Some(domain) = server.strip_prefix("txt:") {
            valid_dns_name(domain)
        } else if let Ok(address) = server.parse::<SocketAddr>() {
            address.port() != 0
        } else if server.parse::<std::net::IpAddr>().is_ok() {
            true
        } else if let Some((host, port)) = server.rsplit_once(':') {
            valid_dns_name(host) && port.parse::<u16>().is_ok_and(|port| port != 0)
        } else {
            valid_dns_name(server)
        };
        anyhow::ensure!(
            valid,
            "invalid {field} endpoint; use host[:port], IP[:port] or txt:domain"
        );
    }
    Ok(())
}

fn parse_socks5_proxy(value: &str) -> anyhow::Result<Option<url::Url>> {
    if value.is_empty() {
        return Ok(None);
    }
    let url = url::Url::parse(value).context("invalid socks5_proxy URL")?;
    anyhow::ensure!(
        url.scheme() == "socks5"
            && matches!(url.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)))
            && url.port().is_some_and(|port| port != 0)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.path(), "" | "/"),
        "socks5_proxy must be socks5://IP:port with no authentication, path, query or fragment"
    );
    Ok(Some(url))
}

/// Shared by native and portable management projections. Lists retain their
/// TOML presence so absent defaults cannot turn into explicitly disabled STUN.
pub(crate) fn populate_extended_config(config: &impl ConfigLoader, result: &mut NetworkConfig) {
    let flags = config.get_flags();
    result.default_protocol = Some(flags.default_protocol);
    result.stun_servers = config
        .get_stun_servers()
        .map(|values| manage::ConfigStringList { values });
    result.tcp_stun_servers = config
        .get_tcp_stun_servers()
        .map(|values| manage::ConfigStringList { values });
    result.stun_servers_v6 = config
        .get_stun_servers_v6()
        .map(|values| manage::ConfigStringList { values });
    result.foreign_relay_bps_limit = Some(flags.foreign_relay_bps_limit);
    result.disable_relay_kcp = Some(flags.disable_relay_kcp);
    result.disable_relay_quic = Some(flags.disable_relay_quic);
    result.enable_relay_foreign_network_kcp = Some(flags.enable_relay_foreign_network_kcp);
    result.enable_relay_foreign_network_quic = Some(flags.enable_relay_foreign_network_quic);
    result.tld_dns_zone = Some(flags.tld_dns_zone);
    result.virtual_ipv6 = config.get_ipv6().map(|address| address.to_string());
    result.tcp_whitelist = config
        .get_tcp_whitelist_config()
        .map(|values| manage::ConfigStringList { values });
    result.udp_whitelist = config
        .get_udp_whitelist_config()
        .map(|values| manage::ConfigStringList { values });
    result.socks5_proxy = config.get_socks5_portal().map(|url| url.to_string());
    result.instance_name = config.get_inst_name_config();
    result.netns = config.get_netns();
}

impl NetworkConfigExt for NetworkConfig {
    #[allow(deprecated)]
    fn gen_config(&self) -> Result<TomlConfigLoader, anyhow::Error> {
        let cfg = TomlConfigLoader::default();
        cfg.set_id(
            self.instance_id
                .clone()
                .unwrap_or(uuid::Uuid::new_v4().to_string())
                .parse()
                .with_context(|| format!("failed to parse instance id: {:?}", self.instance_id))?,
        );
        cfg.set_uplink(self.uplink.clone().unwrap_or_default().try_into()?);
        cfg.set_hostname(self.hostname.clone());
        cfg.set_dhcp(self.dhcp.unwrap_or_default());
        if let Some(instance_name) = &self.instance_name {
            anyhow::ensure!(
                instance_name.len() <= 255 && !instance_name.chars().any(char::is_control),
                "instance_name must contain at most 255 bytes without control characters"
            );
        }
        cfg.set_inst_name(
            self.instance_name
                .clone()
                .unwrap_or_else(|| self.network_name.clone().unwrap_or_default()),
        );
        if let Some(netns) = &self.netns {
            anyhow::ensure!(
                netns.len() <= 255
                    && netns == netns.trim()
                    && !matches!(netns.as_str(), "." | "..")
                    && !netns.contains('/')
                    && !netns.chars().any(char::is_control),
                "invalid netns name"
            );
            cfg.set_netns((!netns.is_empty()).then(|| netns.clone()));
        }
        if let Some(ipv6) = self.virtual_ipv6.as_ref().filter(|value| !value.is_empty()) {
            cfg.set_ipv6(Some(
                ipv6.parse::<cidr::Ipv6Inet>()
                    .context("invalid virtual_ipv6 CIDR")?,
            ));
        }
        for (field, servers) in [
            ("stun_servers", self.stun_servers.as_ref()),
            ("tcp_stun_servers", self.tcp_stun_servers.as_ref()),
            ("stun_servers_v6", self.stun_servers_v6.as_ref()),
        ] {
            if let Some(servers) = servers {
                validate_stun_servers(servers, field)?;
            }
        }
        cfg.set_stun_servers(
            self.stun_servers
                .as_ref()
                .map(|servers| servers.values.clone()),
        );
        cfg.set_tcp_stun_servers(
            self.tcp_stun_servers
                .as_ref()
                .map(|servers| servers.values.clone()),
        );
        cfg.set_stun_servers_v6(
            self.stun_servers_v6
                .as_ref()
                .map(|servers| servers.values.clone()),
        );
        let whitelist = crate::config::peers::AclRuleConfig {
            tcp_whitelist: self
                .tcp_whitelist
                .as_ref()
                .map(|list| list.values.clone())
                .unwrap_or_default(),
            udp_whitelist: self
                .udp_whitelist
                .as_ref()
                .map(|list| list.values.clone())
                .unwrap_or_default(),
            ..Default::default()
        };
        whitelist
            .build()
            .context("invalid TCP/UDP port whitelist")?;
        if let Some(list) = &self.tcp_whitelist {
            cfg.set_tcp_whitelist(list.values.clone());
        }
        if let Some(list) = &self.udp_whitelist {
            cfg.set_udp_whitelist(list.values.clone());
        }

        // The web UI does not expose credential inputs directly, but imported/saved
        // NetworkConfig objects still need to preserve credential-mode instances via
        // secure_mode.local_private_key + empty network_secret.
        let credential_secret = if self.network_secret.is_some() {
            None
        } else {
            self.secure_mode
                .as_ref()
                .and_then(|mode| mode.local_private_key.clone())
                .filter(|s| !s.is_empty())
        };

        if credential_secret.is_some() {
            cfg.set_network_identity(NetworkIdentity::new_credential(
                self.network_name.clone().unwrap_or_default(),
            ));
        } else {
            cfg.set_network_identity(NetworkIdentity::new(
                self.network_name.clone().unwrap_or_default(),
                self.network_secret.clone().unwrap_or_default(),
            ));
        }

        if !cfg.get_dhcp() {
            let virtual_ipv4 = self.virtual_ipv4.clone().unwrap_or_default();
            if !virtual_ipv4.is_empty() {
                let ip = format!("{}/{}", virtual_ipv4, self.network_length.unwrap_or(24))
                    .parse()
                    .with_context(|| {
                        format!(
                            "failed to parse ipv4 inet address: {}, {:?}",
                            virtual_ipv4, self.network_length
                        )
                    })?;
                cfg.set_ipv4(Some(ip));
            }
        }

        match NetworkingMethod::try_from(self.networking_method.unwrap_or_default())
            .unwrap_or_default()
        {
            NetworkingMethod::PublicServer => {
                let peers = parse_peers(&self.peers)?;
                if peers.is_empty() {
                    let public_server_url = self.public_server_url.clone().unwrap_or_default();
                    cfg.set_peers(vec![PeerConfig {
                        uri: public_server_url.parse().with_context(|| {
                            format!("failed to parse public server uri: {}", public_server_url)
                        })?,
                        peer_public_key: None,
                    }]);
                } else {
                    cfg.set_peers(peers);
                }
            }
            NetworkingMethod::Manual => {
                let mut peers = parse_peers(&self.peers)?;
                if peers.is_empty() {
                    peers = parse_peer_urls(&self.peer_urls)?;
                }
                if !peers.is_empty() {
                    cfg.set_peers(peers);
                }
            }
            NetworkingMethod::Standalone => {}
        }

        let mut listener_urls = vec![];
        for listener_url in self.listener_urls.iter() {
            if listener_url.is_empty() {
                continue;
            }
            listener_urls.push(
                listener_url
                    .parse()
                    .with_context(|| format!("failed to parse listener uri: {}", listener_url))?,
            );
        }
        cfg.set_listeners(listener_urls);

        for n in self.proxy_cidrs.iter() {
            add_proxy_network_to_config(n, &cfg)?;
        }

        if !self.port_forwards.is_empty() {
            cfg.set_port_forwards(
                self.port_forwards
                    .iter()
                    .filter(|pf| !pf.bind_ip.is_empty() && !pf.dst_ip.is_empty())
                    .filter_map(|pf| {
                        let bind_addr =
                            format!("{}:{}", pf.bind_ip, pf.bind_port).parse::<SocketAddr>();
                        let dst_addr =
                            format!("{}:{}", pf.dst_ip, pf.dst_port).parse::<SocketAddr>();

                        match (bind_addr, dst_addr) {
                            (Ok(bind_addr), Ok(dst_addr)) => Some(PortForwardConfig {
                                bind_addr,
                                dst_addr,
                                proto: pf.proto.clone(),
                            }),
                            _ => None,
                        }
                    })
                    .collect::<Vec<_>>(),
            );
        }

        if self.enable_vpn_portal == Some(true) {
            anyhow::bail!(
                "legacy VPN portal configuration is no longer supported; configure vpn_portal_config with named clients"
            );
        }

        if let Some(vpn_config) = &self.vpn_portal_config {
            cfg.set_vpn_portal_config(VpnPortalConfig {
                enabled: vpn_config.enabled,
                wireguard_listen: vpn_config.wireguard_listen.parse().with_context(|| {
                    format!(
                        "failed to parse vpn portal wireguard listen address: {}",
                        vpn_config.wireguard_listen
                    )
                })?,
                wireguard_private_key: vpn_config.wireguard_private_key.clone(),
                clients: vpn_config
                    .clients
                    .iter()
                    .map(|client| {
                        Ok(VpnPortalClientConfig {
                            name: client.name.clone(),
                            virtual_ip: client.virtual_ip.parse().with_context(|| {
                                format!(
                                    "failed to parse vpn portal virtual IP for client {}: {}",
                                    client.name, client.virtual_ip
                                )
                            })?,
                            groups: client.groups.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, anyhow::Error>>()?,
            });
        }

        if self.enable_manual_routes.unwrap_or_default() {
            let mut routes = Vec::<cidr::Ipv4Cidr>::with_capacity(self.routes.len());
            for route in self.routes.iter() {
                routes.push(
                    route
                        .parse()
                        .with_context(|| format!("failed to parse route: {}", route))?,
                );
            }
            cfg.set_routes(Some(routes));
        }

        if !self.exit_nodes.is_empty() {
            let mut exit_nodes = Vec::<std::net::IpAddr>::with_capacity(self.exit_nodes.len());
            for node in self.exit_nodes.iter() {
                exit_nodes.push(
                    node.parse()
                        .with_context(|| format!("failed to parse exit node: {}", node))?,
                );
            }
            cfg.set_exit_nodes(exit_nodes);
        }

        if let Some(url) = &self.socks5_proxy {
            cfg.set_socks5_portal(parse_socks5_proxy(url)?);
        } else if self.enable_socks5.unwrap_or_default()
            && let Some(socks5_port) = self.socks5_port
        {
            anyhow::ensure!(
                (1..=65535).contains(&socks5_port),
                "socks5_port must be between 1 and 65535"
            );
            cfg.set_socks5_portal(Some(format!("socks5://0.0.0.0:{}", socks5_port).parse()?));
        }

        if !self.mapped_listeners.is_empty() {
            let mapped_listeners = parse_mapped_listener_urls(&self.mapped_listeners)?;
            cfg.set_mapped_listeners(Some(mapped_listeners));
        }

        if let Some(credential_file) = self
            .credential_file
            .as_ref()
            .filter(|path| !path.is_empty())
        {
            cfg.set_credential_file(Some(credential_file.into()));
        }

        cfg.set_managed_credentials(
            self.managed_credentials
                .iter()
                .map(managed_credential_from_proto)
                .collect(),
        );

        if let Some(credential_secret) = credential_secret {
            cfg.set_secure_mode(Some(normalize_secure_mode_config(
                easytier_proto::common::SecureModeConfig {
                    enabled: true,
                    local_private_key: Some(credential_secret),
                    local_public_key: None,
                },
            )?));
        } else {
            cfg.set_secure_mode(
                self.secure_mode
                    .clone()
                    .map(normalize_secure_mode_config)
                    .transpose()?,
            );
        }

        let mut flags = gen_default_flags();
        if let Some(protocol) = &self.default_protocol {
            anyhow::ensure!(
                matches!(
                    protocol.as_str(),
                    "tcp" | "udp" | "wg" | "quic" | "ws" | "wss" | "faketcp"
                ),
                "invalid default_protocol"
            );
            flags.default_protocol = protocol.clone();
        }
        if let Some(zone) = &self.tld_dns_zone {
            anyhow::ensure!(valid_dns_name(zone), "invalid tld_dns_zone");
            flags.tld_dns_zone = zone.clone();
        }
        if let Some(limit) = self.foreign_relay_bps_limit {
            flags.foreign_relay_bps_limit = limit;
        }
        if let Some(value) = self.disable_relay_kcp {
            flags.disable_relay_kcp = value;
        }
        if let Some(value) = self.disable_relay_quic {
            flags.disable_relay_quic = value;
        }
        if let Some(value) = self.enable_relay_foreign_network_kcp {
            flags.enable_relay_foreign_network_kcp = value;
        }
        if let Some(value) = self.enable_relay_foreign_network_quic {
            flags.enable_relay_foreign_network_quic = value;
        }
        if let Some(latency_first) = self.latency_first {
            flags.latency_first = latency_first;
        }

        if let Some(dev_name) = self.dev_name.clone() {
            flags.dev_name = dev_name;
        }

        if let Some(use_smoltcp) = self.use_smoltcp {
            flags.use_smoltcp = use_smoltcp;
        }

        if let Some(ipv6_public_addr_provider) = self.ipv6_public_addr_provider {
            cfg.set_ipv6_public_addr_provider(ipv6_public_addr_provider);
        }

        if let Some(ipv6_public_addr_auto) = self.ipv6_public_addr_auto {
            cfg.set_ipv6_public_addr_auto(ipv6_public_addr_auto);
        }

        if let Some(ipv6_public_addr_prefix) = self
            .ipv6_public_addr_prefix
            .as_ref()
            .filter(|prefix| !prefix.is_empty())
        {
            cfg.set_ipv6_public_addr_prefix(Some(ipv6_public_addr_prefix.parse().with_context(
                || format!("failed to parse ipv6 public address prefix: {ipv6_public_addr_prefix}"),
            )?));
        }

        if let Some(disable_ipv6) = self.disable_ipv6 {
            flags.enable_ipv6 = !disable_ipv6;
        }

        if let Some(prefer_ipv6) = self.prefer_ipv6 {
            flags.prefer_ipv6 = prefer_ipv6;
        }

        if let Some(enable_kcp_proxy) = self.enable_kcp_proxy {
            flags.enable_kcp_proxy = enable_kcp_proxy;
        }

        if let Some(disable_kcp_input) = self.disable_kcp_input {
            flags.disable_kcp_input = disable_kcp_input;
        }

        if let Some(enable_quic_proxy) = self.enable_quic_proxy {
            flags.enable_quic_proxy = enable_quic_proxy;
        }

        if let Some(disable_quic_input) = self.disable_quic_input {
            flags.disable_quic_input = disable_quic_input;
        }

        if let Some(disable_p2p) = self.disable_p2p {
            flags.disable_p2p = disable_p2p;
        }

        if let Some(p2p_only) = self.p2p_only {
            flags.p2p_only = p2p_only;
        }

        if let Some(lazy_p2p) = self.lazy_p2p {
            flags.lazy_p2p = lazy_p2p;
        }

        if let Some(bind_device) = self.bind_device {
            flags.bind_device = bind_device;
        }

        if self.socket_mark.is_some() {
            flags.socket_mark = self.socket_mark;
        }

        if let Some(no_tun) = self.no_tun {
            flags.no_tun = no_tun;
        }

        if let Some(enable_exit_node) = self.enable_exit_node {
            flags.enable_exit_node = enable_exit_node;
        }

        if let Some(relay_all_peer_rpc) = self.relay_all_peer_rpc {
            flags.relay_all_peer_rpc = relay_all_peer_rpc;
        }

        if let Some(need_p2p) = self.need_p2p {
            flags.need_p2p = need_p2p;
        }

        if let Some(multi_thread) = self.multi_thread {
            flags.multi_thread = multi_thread;
        }

        if let Some(proxy_forward_by_system) = self.proxy_forward_by_system {
            flags.proxy_forward_by_system = proxy_forward_by_system;
        }

        if let Some(disable_encryption) = self.disable_encryption {
            flags.enable_encryption = !disable_encryption;
        }

        if self.enable_relay_network_whitelist.unwrap_or_default() {
            if !self.relay_network_whitelist.is_empty() {
                flags.relay_network_whitelist = self.relay_network_whitelist.join(" ");
            } else {
                flags.relay_network_whitelist = "".to_string();
            }
        }

        if let Some(disable_tcp_hole_punching) = self.disable_tcp_hole_punching {
            flags.disable_tcp_hole_punching = disable_tcp_hole_punching;
        }

        if let Some(disable_udp_hole_punching) = self.disable_udp_hole_punching {
            flags.disable_udp_hole_punching = disable_udp_hole_punching;
        }

        if let Some(disable_upnp) = self.disable_upnp {
            flags.disable_upnp = disable_upnp;
        }

        if let Some(disable_relay_data) = self.disable_relay_data {
            flags.disable_relay_data = disable_relay_data;
        }

        if let Some(prefer_peer_relay) = self.prefer_peer_relay {
            flags.prefer_peer_relay = prefer_peer_relay;
        }

        if let Some(enable_udp_broadcast_relay) = self.enable_udp_broadcast_relay {
            flags.enable_udp_broadcast_relay = enable_udp_broadcast_relay;
        }

        if let Some(disable_sym_hole_punching) = self.disable_sym_hole_punching {
            flags.disable_sym_hole_punching = disable_sym_hole_punching;
        }

        if let Some(enable_magic_dns) = self.enable_magic_dns {
            flags.accept_dns = enable_magic_dns;
        }

        if let Some(mtu) = self.mtu {
            flags.mtu = mtu as u32;
        }

        if let Some(instance_recv_bps_limit) = self.instance_recv_bps_limit {
            flags.instance_recv_bps_limit = instance_recv_bps_limit;
        }

        if let Some(enable_private_mode) = self.enable_private_mode {
            flags.private_mode = enable_private_mode;
        }

        if let Some(encryption_algorithm) = self.encryption_algorithm.clone() {
            anyhow::ensure!(
                encryption_algorithm
                    .parse::<crate::config::EncryptionAlgorithm>()
                    .is_ok(),
                "invalid encryption_algorithm"
            );
            flags.encryption_algorithm = encryption_algorithm;
        }

        if let Some(acl) = self.acl.as_ref()
            && !acl.is_empty()
        {
            cfg.set_acl(Some(acl.clone()));
        }

        if let Some(data_compress_algo) = self.data_compress_algo {
            if data_compress_algo < 1 {
                flags.data_compress_algo = 1;
            } else {
                flags.data_compress_algo = data_compress_algo
            }
        }

        cfg.set_flags(flags);
        Ok(cfg)
    }

    fn new_from_config(config: impl ConfigLoader) -> Result<Self, anyhow::Error> {
        let default_config = TomlConfigLoader::default();

        let mut result = Self {
            ..Default::default()
        };

        result.instance_id = Some(config.get_id().to_string());
        if config.get_hostname() != default_config.get_hostname() {
            result.hostname = Some(config.get_hostname());
        }

        result.dhcp = Some(config.get_dhcp());

        let network_identity = config.get_network_identity();
        result.network_name = Some(network_identity.network_name.clone());
        result.network_secret = network_identity.network_secret;

        if let Some(ipv4) = config.get_ipv4() {
            result.virtual_ipv4 = Some(ipv4.address().to_string());
            result.network_length = Some(ipv4.network_length() as i32);
        }

        if config.get_ipv6_public_addr_provider() != default_config.get_ipv6_public_addr_provider()
        {
            result.ipv6_public_addr_provider = Some(config.get_ipv6_public_addr_provider());
        }
        if config.get_ipv6_public_addr_auto() != default_config.get_ipv6_public_addr_auto() {
            result.ipv6_public_addr_auto = Some(config.get_ipv6_public_addr_auto());
        }
        result.ipv6_public_addr_prefix = config
            .get_ipv6_public_addr_prefix()
            .map(|prefix| prefix.to_string());

        let peers = config.get_peers();
        result.networking_method = Some(NetworkingMethod::Manual as i32);
        if !peers.is_empty() {
            result.peer_urls = peers.iter().map(|p| p.uri.to_string()).collect();
            result.peers = peers
                .iter()
                .map(|p| manage::NetworkPeerConfig {
                    uri: p.uri.to_string(),
                    peer_public_key: p.peer_public_key.clone(),
                })
                .collect();
        }

        result.listener_urls = config
            .get_listeners()
            .unwrap_or_default()
            .iter()
            .map(|l| l.to_string())
            .collect();

        result.proxy_cidrs = config
            .get_proxy_cidrs()
            .iter()
            .map(|c| {
                if let Some(mapped) = c.mapped_cidr {
                    format!("{}->{}", c.cidr, mapped)
                } else {
                    c.cidr.to_string()
                }
            })
            .collect();

        let port_forwards = config.get_port_forwards();
        if !port_forwards.is_empty() {
            result.port_forwards = port_forwards
                .iter()
                .map(|f| manage::PortForwardConfig {
                    proto: f.proto.clone(),
                    bind_ip: f.bind_addr.ip().to_string(),
                    bind_port: f.bind_addr.port() as u32,
                    dst_ip: f.dst_addr.ip().to_string(),
                    dst_port: f.dst_addr.port() as u32,
                })
                .collect();
        }

        if let Some(vpn_config) = config.get_vpn_portal_config() {
            result.vpn_portal_config = Some(manage::VpnPortalConfig {
                enabled: vpn_config.enabled,
                wireguard_listen: vpn_config.wireguard_listen.to_string(),
                wireguard_private_key: vpn_config.wireguard_private_key,
                clients: vpn_config
                    .clients
                    .into_iter()
                    .map(|client| manage::VpnPortalClientConfig {
                        name: client.name,
                        virtual_ip: client.virtual_ip.to_string(),
                        groups: client.groups,
                    })
                    .collect(),
            });
        }

        if let Some(routes) = config.get_routes()
            && !routes.is_empty()
        {
            result.enable_manual_routes = Some(true);
            result.routes = routes.iter().map(|r| r.to_string()).collect();
        }

        let exit_nodes = config.get_exit_nodes();
        if !exit_nodes.is_empty() {
            result.exit_nodes = exit_nodes.iter().map(|n| n.to_string()).collect();
        }

        if let Some(socks5_portal) = config.get_socks5_portal() {
            result.enable_socks5 = Some(true);
            result.socks5_port = socks5_portal.port().map(|p| p as i32);
        }

        let mapped_listeners = config.get_mapped_listeners();
        if !mapped_listeners.is_empty() {
            result.mapped_listeners = mapped_listeners.iter().map(|l| l.to_string()).collect();
        }

        result.secure_mode = config.get_secure_mode();
        result.credential_file = config
            .get_credential_file()
            .map(|path| path.to_string_lossy().into_owned());
        result.managed_credentials = config
            .get_managed_credentials()
            .into_iter()
            .map(managed_credential_to_proto)
            .collect();
        let flags = config.get_flags();
        let default_flags = default_config.get_flags();
        result.latency_first = Some(flags.latency_first);
        result.dev_name = Some(flags.dev_name.clone());
        result.use_smoltcp = Some(flags.use_smoltcp);
        result.disable_ipv6 = Some(!flags.enable_ipv6);
        result.prefer_ipv6 = Some(flags.prefer_ipv6);
        result.enable_kcp_proxy = Some(flags.enable_kcp_proxy);
        result.disable_kcp_input = Some(flags.disable_kcp_input);
        result.enable_quic_proxy = Some(flags.enable_quic_proxy);
        result.disable_quic_input = Some(flags.disable_quic_input);
        result.disable_p2p = Some(flags.disable_p2p);
        result.p2p_only = Some(flags.p2p_only);
        result.lazy_p2p = Some(flags.lazy_p2p);
        result.uplink = Some(config.get_uplink().into());
        result.bind_device = Some(flags.bind_device);
        result.socket_mark = flags.socket_mark;
        result.no_tun = Some(flags.no_tun);
        result.enable_exit_node = Some(flags.enable_exit_node);
        result.relay_all_peer_rpc = Some(flags.relay_all_peer_rpc);
        result.need_p2p = Some(flags.need_p2p);
        result.multi_thread = Some(flags.multi_thread);
        result.proxy_forward_by_system = Some(flags.proxy_forward_by_system);
        result.disable_encryption = Some(!flags.enable_encryption);
        result.disable_tcp_hole_punching = Some(flags.disable_tcp_hole_punching);
        result.disable_udp_hole_punching = Some(flags.disable_udp_hole_punching);
        result.disable_upnp = Some(flags.disable_upnp);
        result.disable_relay_data = Some(flags.disable_relay_data);
        result.prefer_peer_relay = Some(flags.prefer_peer_relay);
        result.enable_udp_broadcast_relay = Some(flags.enable_udp_broadcast_relay);
        result.disable_sym_hole_punching = Some(flags.disable_sym_hole_punching);
        result.enable_magic_dns = Some(flags.accept_dns);
        result.mtu = Some(flags.mtu as i32);
        result.data_compress_algo = (flags.data_compress_algo != default_flags.data_compress_algo)
            .then_some(flags.data_compress_algo);
        result.encryption_algorithm = (flags.encryption_algorithm
            != default_flags.encryption_algorithm)
            .then_some(flags.encryption_algorithm.clone());
        result.instance_recv_bps_limit =
            (flags.instance_recv_bps_limit != u64::MAX).then_some(flags.instance_recv_bps_limit);
        result.enable_private_mode = Some(flags.private_mode);

        result.acl = config.get_acl();

        if flags.relay_network_whitelist == "*" {
            result.enable_relay_network_whitelist = Some(false);
        } else {
            result.enable_relay_network_whitelist = Some(true);
            if flags.relay_network_whitelist.is_empty() {
                result.relay_network_whitelist = vec![];
            } else {
                result.relay_network_whitelist = flags
                    .relay_network_whitelist
                    .split_whitespace()
                    .map(|s| s.to_string())
                    .collect();
            }
        }

        populate_extended_config(&config, &mut result);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    #![allow(deprecated)]

    use super::*;

    fn api_portal_config() -> manage::VpnPortalConfig {
        manage::VpnPortalConfig {
            enabled: None,
            wireguard_listen: "0.0.0.0:51820".to_owned(),
            wireguard_private_key: Some("server-private-key".to_owned()),
            clients: vec![manage::VpnPortalClientConfig {
                name: "alice".to_owned(),
                virtual_ip: "10.144.144.10/16".to_owned(),
                groups: vec!["staff".to_owned()],
            }],
        }
    }

    fn standalone_config() -> NetworkConfig {
        NetworkConfig {
            networking_method: Some(NetworkingMethod::Standalone as i32),
            ..Default::default()
        }
    }

    fn list(values: &[&str]) -> Option<manage::ConfigStringList> {
        Some(manage::ConfigStringList {
            values: values.iter().map(|value| value.to_string()).collect(),
        })
    }

    #[test]
    fn extended_management_fields_roundtrip_through_real_toml_and_both_projections() {
        let input = NetworkConfig {
            network_name: Some("shared-network".into()),
            instance_name: Some("independent-instance".into()),
            netns: Some("vpn_namespace".into()),
            virtual_ipv6: Some("fd00:1234::7/64".into()),
            default_protocol: Some("udp".into()),
            stun_servers: list(&["txt:stun.example.com", "192.0.2.1:3478"]),
            tcp_stun_servers: list(&["stun.example.com:3479"]),
            stun_servers_v6: list(&["[2001:db8::1]:3478"]),
            tcp_whitelist: list(&["22", "8000-8100"]),
            udp_whitelist: list(&["53"]),
            foreign_relay_bps_limit: Some(u64::MAX - 3),
            disable_relay_kcp: Some(true),
            disable_relay_quic: Some(true),
            enable_relay_foreign_network_kcp: Some(true),
            enable_relay_foreign_network_quic: Some(true),
            tld_dns_zone: Some("office.example.".into()),
            socks5_proxy: Some("socks5://[::1]:1088".into()),
            ..standalone_config()
        };
        let native = input.gen_config().unwrap();
        let reparsed = TomlConfigLoader::new_from_str(&native.dump()).unwrap();
        let output = NetworkConfig::new_from_config(&reparsed).unwrap();
        assert_eq!(output.instance_name, input.instance_name);
        assert_eq!(output.netns, input.netns);
        assert_eq!(output.virtual_ipv6, input.virtual_ipv6);
        assert_eq!(output.default_protocol, input.default_protocol);
        assert_eq!(output.stun_servers, input.stun_servers);
        assert_eq!(output.tcp_stun_servers, input.tcp_stun_servers);
        assert_eq!(output.stun_servers_v6, input.stun_servers_v6);
        assert_eq!(output.tcp_whitelist, input.tcp_whitelist);
        assert_eq!(output.udp_whitelist, input.udp_whitelist);
        assert_eq!(
            output.foreign_relay_bps_limit,
            input.foreign_relay_bps_limit
        );
        assert_eq!(output.disable_relay_kcp, input.disable_relay_kcp);
        assert_eq!(output.disable_relay_quic, input.disable_relay_quic);
        assert_eq!(
            output.enable_relay_foreign_network_kcp,
            input.enable_relay_foreign_network_kcp
        );
        assert_eq!(
            output.enable_relay_foreign_network_quic,
            input.enable_relay_foreign_network_quic
        );
        assert_eq!(output.tld_dns_zone, input.tld_dns_zone);
        assert_eq!(output.socks5_proxy, input.socks5_proxy);
        assert_eq!(reparsed.get_inst_name(), "independent-instance");
        assert_eq!(
            reparsed.get_network_identity().network_name,
            "shared-network"
        );
        #[cfg(feature = "web-client")]
        assert_eq!(
            crate::config::api::network_config_from_toml(&reparsed),
            output
        );
    }

    #[test]
    fn list_message_presence_preserves_inheritance_and_explicit_empty() {
        for state in [None, list(&[]), list(&["stun.example.com:3478"])] {
            let input = NetworkConfig {
                stun_servers: state.clone(),
                tcp_stun_servers: state.clone(),
                stun_servers_v6: state.clone(),
                tcp_whitelist: state.as_ref().map(|value| manage::ConfigStringList {
                    values: value.values.iter().map(|_| "80".into()).collect(),
                }),
                udp_whitelist: state.as_ref().map(|value| manage::ConfigStringList {
                    values: value.values.iter().map(|_| "53".into()).collect(),
                }),
                ..standalone_config()
            };
            let native = input.gen_config().unwrap();
            let reparsed = TomlConfigLoader::new_from_str(&native.dump()).unwrap();
            let output = NetworkConfig::new_from_config(&reparsed).unwrap();
            assert_eq!(output.stun_servers, input.stun_servers);
            assert_eq!(output.tcp_stun_servers, input.tcp_stun_servers);
            assert_eq!(output.stun_servers_v6, input.stun_servers_v6);
            assert_eq!(output.tcp_whitelist, input.tcp_whitelist);
            assert_eq!(output.udp_whitelist, input.udp_whitelist);
            let json = serde_json::to_value(&output).unwrap();
            let decoded: NetworkConfig = serde_json::from_value(json).unwrap();
            assert_eq!(decoded.stun_servers, state);
            #[cfg(feature = "web-client")]
            assert_eq!(
                crate::config::api::network_config_from_toml(&reparsed),
                output
            );
        }
    }

    #[test]
    fn socks5_url_override_preserves_binding_and_can_disable_legacy_configuration() {
        let input = NetworkConfig {
            enable_socks5: Some(false),
            socks5_port: Some(1080),
            socks5_proxy: Some("socks5://127.0.0.2:9090".into()),
            ..standalone_config()
        };
        assert_eq!(
            input
                .gen_config()
                .unwrap()
                .get_socks5_portal()
                .unwrap()
                .as_str(),
            "socks5://127.0.0.2:9090"
        );
        let disabled = NetworkConfig {
            enable_socks5: Some(true),
            socks5_proxy: Some(String::new()),
            ..input.clone()
        };
        assert!(disabled.gen_config().unwrap().get_socks5_portal().is_none());
        let legacy = NetworkConfig {
            enable_socks5: Some(true),
            socks5_proxy: None,
            ..input
        };
        assert_eq!(
            legacy
                .gen_config()
                .unwrap()
                .get_socks5_portal()
                .unwrap()
                .as_str(),
            "socks5://0.0.0.0:1080"
        );
    }

    #[test]
    fn omitted_extended_fields_keep_previous_defaults_and_zero_relay_limit_is_valid() {
        let input = NetworkConfig {
            network_name: Some("legacy-name".into()),
            ..standalone_config()
        };
        let native = input.gen_config().unwrap();
        assert_eq!(native.get_inst_name(), "legacy-name");
        assert_eq!(native.get_flags(), gen_default_flags());
        assert_eq!(native.get_stun_servers(), None);
        assert_eq!(native.get_tcp_stun_servers(), None);
        assert_eq!(native.get_stun_servers_v6(), None);
        assert_eq!(native.get_tcp_whitelist_config(), None);
        assert_eq!(native.get_udp_whitelist_config(), None);
        assert_eq!(native.get_netns(), None);
        assert_eq!(native.get_ipv6(), None);
        assert_eq!(
            NetworkConfig {
                foreign_relay_bps_limit: Some(0),
                ..input
            }
            .gen_config()
            .unwrap()
            .get_flags()
            .foreign_relay_bps_limit,
            0
        );
    }

    #[test]
    fn invalid_extended_management_values_are_rejected_without_starting_an_instance() {
        let mut invalid = vec![
            NetworkConfig {
                default_protocol: Some("invalid".into()),
                ..standalone_config()
            },
            NetworkConfig {
                virtual_ipv6: Some("192.0.2.1/24".into()),
                ..standalone_config()
            },
            NetworkConfig {
                virtual_ipv6: Some("fd00::1/129".into()),
                ..standalone_config()
            },
            NetworkConfig {
                netns: Some("../namespace".into()),
                ..standalone_config()
            },
            NetworkConfig {
                netns: Some("..".into()),
                ..standalone_config()
            },
            NetworkConfig {
                netns: Some(".".into()),
                ..standalone_config()
            },
            NetworkConfig {
                netns: Some(" namespace".into()),
                ..standalone_config()
            },
            NetworkConfig {
                netns: Some("namespace ".into()),
                ..standalone_config()
            },
            NetworkConfig {
                instance_name: Some("bad\nname".into()),
                ..standalone_config()
            },
            NetworkConfig {
                encryption_algorithm: Some("rot13".into()),
                ..standalone_config()
            },
            NetworkConfig {
                tcp_whitelist: list(&["9000-8000"]),
                ..standalone_config()
            },
            NetworkConfig {
                udp_whitelist: list(&["65536"]),
                ..standalone_config()
            },
            NetworkConfig {
                enable_socks5: Some(true),
                socks5_port: Some(-1),
                ..standalone_config()
            },
        ];
        for zone in ["", ".", "bad..example", "-bad.example", "bad_.example"] {
            invalid.push(NetworkConfig {
                tld_dns_zone: Some(zone.into()),
                ..standalone_config()
            });
        }
        for endpoint in [
            "",
            "https://stun.example.com",
            "stun.example.com:0",
            "stun.example.com:65536",
            "txt:",
            "[2001:db8::1",
        ] {
            invalid.push(NetworkConfig {
                stun_servers: list(&[endpoint]),
                ..standalone_config()
            });
        }
        for url in [
            "http://127.0.0.1:1080",
            "socks5://127.0.0.1",
            "socks5://127.0.0.1:0",
            "socks5://user:secret@127.0.0.1:1080",
            "socks5://127.0.0.1:1080/path",
            "socks5://127.0.0.1:1080?unused=true",
        ] {
            invalid.push(NetworkConfig {
                socks5_proxy: Some(url.into()),
                ..standalone_config()
            });
        }
        for input in invalid {
            assert!(
                input.gen_config().is_err(),
                "invalid configuration was accepted"
            );
        }
    }

    #[test]
    #[cfg(feature = "browser-config")]
    fn browser_merge_updates_and_clears_newly_managed_fields_without_restoring_old_values() {
        let original = r#"
instance_name = "before"
ipv6 = "fd00::1/64"
netns = "before"
stun_servers = ["stun.before.example"]
tcp_whitelist = ["22"]
socks5_proxy = "socks5://127.0.0.1:1080"
[flags]
default_protocol = "udp"
foreign_relay_bps_limit = "1024"
disable_relay_kcp = true
tld_dns_zone = "before.example."
multi_thread_count = 3
"#;
        let mut input =
            NetworkConfig::new_from_config(&TomlConfigLoader::new_from_str(original).unwrap())
                .unwrap();
        input.instance_name = Some("after".into());
        input.virtual_ipv6 = None;
        input.netns = None;
        input.stun_servers = list(&[]);
        input.tcp_whitelist = list(&[]);
        input.socks5_proxy = Some(String::new());
        input.default_protocol = Some("tcp".into());
        input.foreign_relay_bps_limit = None;
        input.disable_relay_kcp = Some(false);
        input.tld_dns_zone = None;
        let merged = merge_network_config_toml(original, &input).unwrap();
        let native = TomlConfigLoader::new_from_str(&merged).unwrap();
        assert_eq!(native.get_inst_name(), "after");
        assert_eq!(native.get_ipv6(), None);
        assert_eq!(native.get_netns(), None);
        assert_eq!(native.get_stun_servers(), Some(vec![]));
        assert_eq!(native.get_tcp_whitelist_config(), Some(vec![]));
        assert_eq!(native.get_socks5_portal(), None);
        assert_eq!(native.get_flags().default_protocol, "tcp");
        assert_eq!(native.get_flags().foreign_relay_bps_limit, u64::MAX);
        assert!(!native.get_flags().disable_relay_kcp);
        assert_eq!(
            native.get_flags().tld_dns_zone,
            gen_default_flags().tld_dns_zone
        );
        assert_eq!(
            native.get_flags().multi_thread_count,
            3,
            "unmanaged legacy values are still preserved"
        );
    }

    #[test]
    fn prefer_ipv6_api_round_trips_true_false_and_missing() {
        for value in [None, Some(false), Some(true)] {
            let input = NetworkConfig {
                prefer_ipv6: value,
                ..standalone_config()
            };
            let config = input.gen_config().unwrap();
            assert_eq!(config.get_flags().prefer_ipv6, value.unwrap_or(false));
            let output = NetworkConfig::new_from_config(&config).unwrap();
            assert_eq!(output.prefer_ipv6, Some(value.unwrap_or(false)));
        }
    }

    #[test]
    fn prefer_ipv6_does_not_enable_disabled_ipv6() {
        let input = NetworkConfig {
            prefer_ipv6: Some(true),
            disable_ipv6: Some(true),
            ..standalone_config()
        };
        let config = input.gen_config().unwrap();
        assert!(config.get_flags().prefer_ipv6);
        assert!(!config.get_flags().enable_ipv6);
        let output = NetworkConfig::new_from_config(&config).unwrap();
        assert_eq!(output.prefer_ipv6, Some(true));
        assert_eq!(output.disable_ipv6, Some(true));
    }

    #[test]
    fn vpn_portal_api_config_round_trips_through_toml_model() {
        let input = NetworkConfig {
            vpn_portal_config: Some(api_portal_config()),
            ..standalone_config()
        };

        let config = input.gen_config().unwrap();
        let portal = config.get_vpn_portal_config().unwrap();
        assert_eq!(portal.wireguard_listen, "0.0.0.0:51820".parse().unwrap());
        assert_eq!(
            portal.wireguard_private_key.as_deref(),
            Some("server-private-key")
        );
        assert_eq!(portal.clients[0].name, "alice");
        assert_eq!(portal.clients[0].virtual_ip.to_string(), "10.144.144.10/16");
        assert_eq!(portal.clients[0].groups, vec!["staff".to_owned()]);

        let output = NetworkConfig::new_from_config(&config).unwrap();
        assert_eq!(output.vpn_portal_config, input.vpn_portal_config);
        assert_eq!(output.enable_vpn_portal, None);
    }

    #[test]
    fn disabled_vpn_portal_preserves_clients_and_key_without_a_runtime() {
        let mut portal = api_portal_config();
        portal.enabled = Some(false);
        let input = NetworkConfig {
            vpn_portal_config: Some(portal),
            ..standalone_config()
        };
        let config = input.gen_config().unwrap();
        let restored = crate::config::toml::TomlConfig::new_from_str(&config.dump()).unwrap();
        let output = NetworkConfig::new_from_config(&restored).unwrap();
        assert_eq!(output.vpn_portal_config, input.vpn_portal_config);
        assert!(
            crate::instance::CoreInstanceConfig::from_toml(&restored)
                .unwrap()
                .vpn_portal
                .is_none()
        );

        let mut portal = restored.get_vpn_portal_config().unwrap();
        portal.enabled = Some(true);
        restored.set_vpn_portal_config(portal);
        let runtime = crate::instance::CoreInstanceConfig::from_toml(&restored).unwrap();
        assert_eq!(runtime.vpn_portal.unwrap().clients[0].name, "alice");
    }

    #[test]
    fn managed_credentials_round_trip_through_toml_model() {
        let input = NetworkConfig {
            managed_credentials: vec![manage::ManagedCredentialConfig {
                credential_id: "managed-a".to_owned(),
                credential_secret: "secret".to_owned(),
                groups: vec!["ops".to_owned()],
                allow_relay: true,
                allowed_proxy_cidrs: vec!["10.0.0.0/24".to_owned()],
                expiry_unix: 2_000_000_000,
                reusable: None,
            }],
            ..standalone_config()
        };

        let config = input.gen_config().unwrap();
        let output = NetworkConfig::new_from_config(&config).unwrap();
        assert_eq!(output.managed_credentials[0].credential_id, "managed-a");
        assert_eq!(output.managed_credentials[0].reusable, Some(true));
    }

    #[test]
    fn peer_relay_preference_round_trips_independently() {
        let input = NetworkConfig {
            disable_relay_data: Some(false),
            prefer_peer_relay: Some(true),
            ..standalone_config()
        };

        let config = input.gen_config().unwrap();
        let flags = config.get_flags();
        assert!(!flags.disable_relay_data);
        assert!(flags.prefer_peer_relay);

        let output = NetworkConfig::new_from_config(&config).unwrap();
        assert_eq!(output.disable_relay_data, Some(false));
        assert_eq!(output.prefer_peer_relay, Some(true));
    }

    #[test]
    fn legacy_enabled_vpn_portal_config_reports_migration_error() {
        let error = NetworkConfig {
            enable_vpn_portal: Some(true),
            ..standalone_config()
        }
        .gen_config()
        .unwrap_err()
        .to_string();

        assert!(error.contains("legacy VPN portal"), "{error}");
    }

    #[test]
    fn legacy_disabled_vpn_portal_defaults_are_ignored() {
        let config = NetworkConfig {
            enable_vpn_portal: Some(false),
            vpn_portal_listen_port: Some(0),
            vpn_portal_client_network_addr: Some(String::new()),
            vpn_portal_client_network_len: Some(0),
            ..standalone_config()
        }
        .gen_config()
        .unwrap();

        assert!(config.get_vpn_portal_config().is_none());
    }

    #[cfg(feature = "browser-config")]
    #[test]
    fn prefer_ipv6_browser_merge_can_clear_a_saved_preference() {
        let original = "[flags]\nprefer_ipv6 = true\ndefault_protocol = \"udp\"\n";
        let parsed = TomlConfigLoader::new_from_str(original).unwrap();
        let mut input = NetworkConfig::new_from_config(&parsed).unwrap();
        input.prefer_ipv6 = Some(false);
        let merged = merge_network_config_toml(original, &input).unwrap();
        let reloaded = TomlConfigLoader::new_from_str(&merged).unwrap();
        assert!(!reloaded.get_flags().prefer_ipv6);
        assert_eq!(reloaded.get_flags().default_protocol, "udp");

        input.prefer_ipv6 = Some(true);
        let merged = merge_network_config_toml(&merged, &input).unwrap();
        assert!(
            TomlConfigLoader::new_from_str(&merged)
                .unwrap()
                .get_flags()
                .prefer_ipv6
        );
    }

    #[cfg(feature = "browser-config")]
    #[test]
    fn browser_merge_preserves_fields_outside_the_shared_form() {
        let original = r#"
instance_name = "module-instance"
rpc_portal = "0.0.0.0:15888"
tcp_whitelist = ["22"]
stun_servers = ["custom.example.com:3478"]

[network_identity]
network_name = "old-network"
network_secret = "secret"

[flags]
default_protocol = "udp"
disable_p2p = true
"#;
        let parsed = TomlConfigLoader::new_from_str(original).unwrap();
        let mut network_config = NetworkConfig::new_from_config(&parsed).unwrap();
        network_config.network_name = Some("edited-network".to_owned());
        network_config.disable_p2p = Some(false);

        let merged = merge_network_config_toml(original, &network_config).unwrap();
        let merged: toml::Table = toml::from_str(&merged).unwrap();

        assert_eq!(merged["instance_name"].as_str(), Some("module-instance"));
        assert_eq!(merged["rpc_portal"].as_str(), Some("0.0.0.0:15888"));
        assert_eq!(merged["tcp_whitelist"][0].as_str(), Some("22"));
        assert_eq!(
            merged["stun_servers"][0].as_str(),
            Some("custom.example.com:3478")
        );
        assert_eq!(
            merged["network_identity"]["network_name"].as_str(),
            Some("edited-network")
        );
        assert_eq!(merged["flags"]["default_protocol"].as_str(), Some("udp"));
        assert!(
            !merged["flags"]
                .as_table()
                .unwrap()
                .contains_key("disable_p2p")
        );
    }
}

#[cfg(test)]
mod uplink_tests {
    use super::*;
    use crate::config::uplink::{UplinkConfig, UplinkMode};

    #[test]
    fn management_uplink_roundtrip_preserves_manual_selection_and_reset() {
        let config = NetworkConfig {
            networking_method: Some(NetworkingMethod::Standalone as i32),
            uplink: Some(manage::UplinkConfig {
                mode: "manual".to_owned(),
                interfaces: vec!["eth0".to_owned(), "ppp0".to_owned()],
            }),
            ..Default::default()
        };
        let toml = config.gen_config().unwrap();
        assert_eq!(
            toml.get_uplink(),
            UplinkConfig {
                mode: UplinkMode::Manual,
                interfaces: vec!["eth0".to_owned(), "ppp0".to_owned()]
            }
        );
        let mut roundtrip = NetworkConfig::new_from_config(&toml).unwrap();
        assert_eq!(roundtrip.uplink, config.uplink);
        roundtrip.uplink = Some(UplinkConfig::default().into());
        assert_eq!(
            roundtrip.gen_config().unwrap().get_uplink(),
            UplinkConfig::default()
        );
        for policy in [
            manage::UplinkConfig {
                mode: "manual".to_owned(),
                interfaces: vec![],
            },
            manage::UplinkConfig {
                mode: "unknown".to_owned(),
                interfaces: vec![],
            },
        ] {
            assert!(
                NetworkConfig {
                    uplink: Some(policy),
                    ..Default::default()
                }
                .gen_config()
                .is_err()
            );
        }
    }

    #[test]
    #[cfg(feature = "browser-config")]
    fn browser_merge_replaces_previous_uplink_policy_instead_of_restoring_it() {
        let original = "[uplink]\nmode = 'manual'\ninterfaces = ['eth0']";
        let config = NetworkConfig {
            networking_method: Some(NetworkingMethod::Standalone as i32),
            uplink: Some(UplinkConfig::default().into()),
            ..Default::default()
        };
        let merged = merge_network_config_toml(original, &config).unwrap();
        assert_eq!(
            TomlConfigLoader::new_from_str(&merged)
                .unwrap()
                .get_uplink(),
            UplinkConfig::default()
        );
    }
}
