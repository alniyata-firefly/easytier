//! Process configuration containing shared resources and independent networks.

use std::{collections::HashSet, path::PathBuf};

use anyhow::{Context as _, bail};
use tokio::io::AsyncReadExt as _;

use crate::{
    common::config::{
        ConfigFileControl, ConfigLoader as _, TomlConfigLoader, config_file_control_from_path,
        load_config_from_file,
    },
    instance::host_resources::HostResourcesConfig,
};

pub struct LoadedProcessConfig {
    pub host_resources: Option<HostResourcesConfig>,
    pub instances: Vec<(TomlConfigLoader, ConfigFileControl)>,
}

pub(crate) struct ParsedProcessConfig {
    pub host_resources: Option<HostResourcesConfig>,
    pub instances: Vec<TomlConfigLoader>,
    pub is_bundle: bool,
}

/// Parse without logging the input: it can contain VPN keys and credentials.
pub(crate) fn parse_process_config_text(
    text: &str,
    source: &str,
) -> anyhow::Result<ParsedProcessConfig> {
    let table = toml::from_str::<toml::Table>(text)
        .map_err(|_| anyhow::anyhow!("invalid TOML syntax in {source}"))?;
    let is_bundle = table.contains_key("instances") || table.contains_key("host_resources");
    if !is_bundle {
        let instance = TomlConfigLoader::new_from_str_with_source(source, text)
            .map_err(|_| anyhow::anyhow!("invalid network configuration in {source}"))?;
        return Ok(ParsedProcessConfig {
            host_resources: None,
            instances: vec![instance],
            is_bundle: false,
        });
    }
    if table
        .keys()
        .any(|key| key != "instances" && key != "host_resources")
    {
        bail!(
            "{source}: process configuration only accepts host_resources and instances at the root; put network settings inside [[instances]]"
        );
    }
    let host_resources = table
        .get("host_resources")
        .map(|value| {
            value
                .clone()
                .try_into::<HostResourcesConfig>()
                .map_err(|_| anyhow::anyhow!("invalid host_resources settings in {source}"))
        })
        .transpose()?;
    let entries = match table.get("instances") {
        Some(toml::Value::Array(entries)) => entries.as_slice(),
        Some(_) => bail!("{source}: instances must be an array of tables"),
        None => &[],
    };
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut instances = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let instance_table = entry
            .as_table()
            .ok_or_else(|| anyhow::anyhow!("{source}: instances[{index}] must be a table"))?;
        let id = instance_table
            .get("instance_id")
            .and_then(toml::Value::as_str)
            .and_then(|value| uuid::Uuid::parse_str(value).ok())
            .ok_or_else(|| {
                anyhow::anyhow!("{source}: instances[{index}] needs an explicit UUID instance_id")
            })?;
        if !ids.insert(id) {
            bail!("{source}: duplicate instance_id in instances[{index}]");
        }
        let serialized = toml::to_string(instance_table)
            .context("failed to serialize a network configuration")?;
        let instance =
            TomlConfigLoader::new_from_str_with_source(source, &serialized).map_err(|_| {
                anyhow::anyhow!("invalid network settings in {source} instances[{index}]")
            })?;
        // The legacy model stores addresses as strings and silently maps an
        // invalid address to None. A new bundle must reject malformed explicit
        // addresses before it can accidentally start a relay-only instance.
        for (field, missing) in [
            ("ipv4", instance.get_ipv4().is_none()),
            ("ipv6", instance.get_ipv6().is_none()),
        ] {
            if missing
                && instance_table
                    .get(field)
                    .and_then(toml::Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            {
                bail!("{source}: invalid {field} in instances[{index}]");
            }
        }
        if !names.insert(instance.get_inst_name()) {
            bail!("{source}: duplicate instance_name in instances[{index}]; use unique names");
        }
        instances.push(instance);
    }
    Ok(ParsedProcessConfig {
        host_resources,
        instances,
        is_bundle: true,
    })
}

pub async fn load_process_config_file(
    path: &PathBuf,
    config_dir: Option<&PathBuf>,
    disable_env_parsing: bool,
) -> anyhow::Result<LoadedProcessConfig> {
    let from_stdin = path.as_os_str() == "-";
    let mut text = if from_stdin {
        let mut text = String::new();
        tokio::io::stdin()
            .read_to_string(&mut text)
            .await
            .context("failed to read process configuration from stdin")?;
        text
    } else {
        tokio::fs::read_to_string(path)
            .await
            .with_context(|| format!("failed to read config file: {}", path.display()))?
    };
    let uses_env = if disable_env_parsing {
        false
    } else {
        let expanded = super::env_parser::expand_env_vars(&text);
        text = expanded.0;
        expanded.1
    };
    let source = if from_stdin {
        "stdin".to_owned()
    } else {
        path.display().to_string()
    };
    let parsed = parse_process_config_text(&text, &source)?;
    if !parsed.is_bundle && !from_stdin {
        // Keep the original ownership/permission rules for legacy files.
        let loaded = load_config_from_file(path, config_dir, disable_env_parsing).await?;
        return Ok(LoadedProcessConfig {
            host_resources: None,
            instances: vec![loaded],
        });
    }
    let mut control = if from_stdin {
        ConfigFileControl::STATIC_CONFIG
    } else {
        config_file_control_from_path(path.clone()).await
    };
    // An individual instance must never be allowed to delete its shared file.
    control.set_no_delete(true);
    if uses_env {
        control.set_read_only(true);
    }
    Ok(LoadedProcessConfig {
        host_resources: parsed.host_resources,
        instances: parsed
            .instances
            .into_iter()
            .map(|instance| (instance, control.clone()))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = r#"
[host_resources]
enabled = false
interval_seconds = 7
disk_interval_seconds = 70
[[instances]]
instance_id = "11111111-1111-4111-8111-111111111111"
instance_name = "alpha"
ipv4 = "10.211.0.1/24"
[instances.network_identity]
network_name = "alpha-net"
network_secret = "do-not-log-this-secret"
[[instances]]
instance_id = "22222222-2222-4222-8222-222222222222"
instance_name = "beta"
ipv4 = "10.212.0.1/24"
"#;

    #[test]
    fn bundle_keeps_independent_ids_addresses_and_process_policy() {
        let parsed = parse_process_config_text(TWO, "bundle").unwrap();
        assert!(parsed.is_bundle);
        assert_eq!(parsed.instances.len(), 2);
        assert_ne!(parsed.instances[0].get_id(), parsed.instances[1].get_id());
        assert_eq!(parsed.instances[0].get_inst_name(), "alpha");
        assert_eq!(parsed.instances[1].get_inst_name(), "beta");
        assert_ne!(
            parsed.instances[0].get_ipv4(),
            parsed.instances[1].get_ipv4()
        );
        let policy = parsed.host_resources.unwrap();
        assert!(!policy.enabled);
        assert_eq!(policy.interval_seconds, 7);
        assert_eq!(policy.disk_interval_seconds, 70);
    }

    #[test]
    fn legacy_and_empty_process_documents_keep_their_distinct_meanings() {
        let legacy = parse_process_config_text("instance_name = 'legacy'", "legacy").unwrap();
        assert!(!legacy.is_bundle);
        assert_eq!(legacy.instances.len(), 1);
        for text in ["instances = []", "[host_resources]\nenabled = false"] {
            let empty = parse_process_config_text(text, "empty").unwrap();
            assert!(empty.is_bundle);
            assert!(empty.instances.is_empty());
        }
    }

    #[test]
    fn bundle_rejects_unknown_mixed_duplicate_and_unstable_identities() {
        for text in [
            "instances = {}".to_owned(),
            "instances = [1]".to_owned(),
            "[host_resources]\nenabled = true\nunknown = 2".to_owned(),
            "ipv4 = '10.0.0.1'\n[host_resources]\nenabled = true".to_owned(),
            TWO.replace(
                "22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111",
            ),
            TWO.replace("instance_name = \"beta\"", "instance_name = \"alpha\""),
            TWO.replace("instance_id = \"22222222-2222-4222-8222-222222222222\"", ""),
        ] {
            assert!(parse_process_config_text(&text, "invalid").is_err());
        }
    }

    #[test]
    fn parse_errors_never_echo_network_credentials() {
        for text in [
            TWO.replace("enabled = false", "enabled = 'do-not-log-this-secret'"),
            TWO.replace(
                "ipv4 = \"10.211.0.1/24\"",
                "ipv4 = 'do-not-log-this-secret'",
            ),
            TWO.replace(
                "disk_interval_seconds = 70",
                "disk_interval_seconds = [do-not-log-this-secret]",
            ),
        ] {
            let error = parse_process_config_text(&text, "test-source")
                .err()
                .unwrap();
            assert!(!format!("{error:#}").contains("do-not-log-this-secret"));
        }
    }

    #[tokio::test]
    async fn shared_file_instances_cannot_delete_the_whole_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.toml");
        std::fs::write(&path, TWO).unwrap();
        let loaded = load_process_config_file(&path, Some(&directory.path().to_path_buf()), true)
            .await
            .unwrap();
        assert_eq!(loaded.instances.len(), 2);
        for (_, control) in loaded.instances {
            assert_eq!(control.path.as_ref(), Some(&path));
            assert!(control.is_no_delete());
            assert!(!control.is_read_only());
        }
    }
}
