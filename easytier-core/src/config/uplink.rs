//! Portable policy for selecting the interfaces that carry overlay transports.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UplinkMode {
    #[default]
    Auto,
    Manual,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UplinkConfig {
    #[serde(default)]
    pub mode: UplinkMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<String>,
}

impl UplinkConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        match self.mode {
            UplinkMode::Auto if !self.interfaces.is_empty() => {
                anyhow::bail!("automatic uplink selection cannot specify interfaces");
            }
            UplinkMode::Manual if self.interfaces.is_empty() => {
                anyhow::bail!("manual uplink selection requires at least one interface");
            }
            _ => {}
        }
        let mut names = HashSet::new();
        for name in &self.interfaces {
            if name.is_empty() || name.trim() != name || name.chars().any(char::is_control) {
                anyhow::bail!(
                    "uplink interface names must be nonempty, have no surrounding whitespace, and contain no control characters"
                );
            }
            if !names.insert(name) {
                anyhow::bail!("duplicate uplink interface: {name}");
            }
        }
        Ok(())
    }
}

#[cfg(any(feature = "web-client", feature = "browser-config"))]
impl TryFrom<crate::proto::api::manage::UplinkConfig> for UplinkConfig {
    type Error = anyhow::Error;

    fn try_from(value: crate::proto::api::manage::UplinkConfig) -> Result<Self, Self::Error> {
        let mode = match value.mode.as_str() {
            "" | "auto" => UplinkMode::Auto,
            "manual" => UplinkMode::Manual,
            _ => anyhow::bail!("invalid uplink mode: {}", value.mode),
        };
        let config = Self {
            mode,
            interfaces: value.interfaces,
        };
        config.validate()?;
        Ok(config)
    }
}

#[cfg(any(feature = "web-client", feature = "browser-config"))]
impl From<UplinkConfig> for crate::proto::api::manage::UplinkConfig {
    fn from(value: UplinkConfig) -> Self {
        Self {
            mode: match value.mode {
                UplinkMode::Auto => "auto",
                UplinkMode::Manual => "manual",
            }
            .to_owned(),
            interfaces: value.interfaces,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_manual_allowlists_and_rejects_ambiguous_auto_config() {
        assert!(UplinkConfig::default().validate().is_ok());
        assert!(
            UplinkConfig {
                mode: UplinkMode::Manual,
                interfaces: vec!["eth0".into(), "Ethernet 2".into()]
            }
            .validate()
            .is_ok()
        );
        for interfaces in [
            vec![],
            vec![""],
            vec![" eth0"],
            vec!["eth0\0"],
            vec!["eth0", "eth0"],
        ] {
            let config = UplinkConfig {
                mode: UplinkMode::Manual,
                interfaces: interfaces.into_iter().map(String::from).collect(),
            };
            assert!(config.validate().is_err(), "{config:?}");
        }
        assert!(
            UplinkConfig {
                interfaces: vec!["eth0".into()],
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
