//! Process-wide sampling policy from the main TOML and CLI/environment overrides.

use clap::Args;
use rust_i18n::t;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct HostResourcesConfig {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub disk_interval_seconds: u64,
}

impl Default for HostResourcesConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: 5,
            disk_interval_seconds: 60,
        }
    }
}

impl HostResourcesConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            (1..=3600).contains(&self.interval_seconds),
            "host resource interval_seconds must be between 1 and 3600"
        );
        anyhow::ensure!(
            (1..=86400).contains(&self.disk_interval_seconds),
            "host resource disk_interval_seconds must be between 1 and 86400"
        );
        anyhow::ensure!(
            self.disk_interval_seconds >= self.interval_seconds,
            "host resource disk_interval_seconds must not be smaller than interval_seconds"
        );
        Ok(())
    }
}

#[derive(Args, Debug, Default)]
pub struct HostResourcesOptions {
    #[arg(
        long,
        env = "ET_HOST_RESOURCES_ENABLED",
        value_name = "BOOL",
        action = clap::ArgAction::Set,
        help = t!("core_clap.host_resources_enabled").to_string()
    )]
    pub host_resources_enabled: Option<bool>,

    #[arg(
        long,
        env = "ET_HOST_RESOURCES_INTERVAL",
        value_name = "SECONDS",
        help = t!("core_clap.host_resources_interval").to_string()
    )]
    pub host_resources_interval: Option<u64>,

    #[arg(
        long,
        env = "ET_HOST_RESOURCES_DISK_INTERVAL",
        value_name = "SECONDS",
        help = t!("core_clap.host_resources_disk_interval").to_string()
    )]
    pub host_resources_disk_interval: Option<u64>,
}

impl HostResourcesOptions {
    /// Clap resolves command-line values over environment values. These
    /// optional overrides then take precedence over the main TOML and defaults.
    pub fn resolve(
        &self,
        file_config: Option<HostResourcesConfig>,
    ) -> anyhow::Result<HostResourcesConfig> {
        let mut config = file_config.unwrap_or_default();
        if let Some(enabled) = self.host_resources_enabled {
            config.enabled = enabled;
        }
        if let Some(seconds) = self.host_resources_interval {
            config.interval_seconds = seconds;
        }
        if let Some(seconds) = self.host_resources_disk_interval {
            config.disk_interval_seconds = seconds;
        }
        config.validate()?;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory as _, FromArgMatches as _, Parser};

    use super::*;

    #[derive(Parser)]
    struct TestCli {
        #[command(flatten)]
        resources: HostResourcesOptions,
    }

    fn parse(args: &[&str]) -> TestCli {
        // Tests must neither depend on nor mutate the real process environment.
        let matches = TestCli::command()
            .mut_args(|arg| arg.env(None::<&str>))
            .try_get_matches_from(args)
            .unwrap();
        TestCli::from_arg_matches(&matches).unwrap()
    }

    #[test]
    fn defaults_and_partial_resource_table_keep_existing_intervals() {
        assert_eq!(
            HostResourcesOptions::default().resolve(None).unwrap(),
            HostResourcesConfig::default()
        );
        let config: HostResourcesConfig = toml::from_str("enabled = false\n").unwrap();
        assert_eq!(
            HostResourcesOptions::default()
                .resolve(Some(config))
                .unwrap(),
            HostResourcesConfig {
                enabled: false,
                ..Default::default()
            }
        );
    }

    #[test]
    fn parsed_optional_values_override_file_without_defaulting_unset_values() {
        let file_config = HostResourcesConfig {
            enabled: true,
            interval_seconds: 9,
            disk_interval_seconds: 120,
        };
        let cli = parse(&[
            "test",
            "--host-resources-enabled",
            "false",
            "--host-resources-interval",
            "12",
        ]);
        assert_eq!(
            cli.resources.resolve(Some(file_config)).unwrap(),
            HostResourcesConfig {
                enabled: false,
                interval_seconds: 12,
                disk_interval_seconds: 120
            }
        );
    }

    #[test]
    fn cli_overrides_lower_priority_parser_values() {
        // A command-scoped fallback exercises merging without mutating env;
        // actual ET_* precedence is verified by an isolated Core CLI smoke test.
        let matches = TestCli::command()
            .mut_args(|arg| arg.env(None::<&str>))
            .mut_arg("host_resources_enabled", |arg| arg.default_value("true"))
            .mut_arg("host_resources_interval", |arg| arg.default_value("8"))
            .try_get_matches_from([
                "test",
                "--host-resources-enabled",
                "false",
                "--host-resources-interval",
                "10",
            ])
            .unwrap();
        let config = TestCli::from_arg_matches(&matches)
            .unwrap()
            .resources
            .resolve(None)
            .unwrap();
        assert!(!config.enabled);
        assert_eq!(config.interval_seconds, 10);
    }

    #[test]
    fn disabled_sampling_still_validates_intervals_and_cross_field_relation() {
        for config in [
            HostResourcesConfig {
                interval_seconds: 0,
                ..Default::default()
            },
            HostResourcesConfig {
                interval_seconds: 3601,
                disk_interval_seconds: 4000,
                ..Default::default()
            },
            HostResourcesConfig {
                disk_interval_seconds: 0,
                ..Default::default()
            },
            HostResourcesConfig {
                disk_interval_seconds: 86401,
                ..Default::default()
            },
            HostResourcesConfig {
                interval_seconds: 61,
                disk_interval_seconds: 60,
                ..Default::default()
            },
        ] {
            assert!(
                HostResourcesConfig {
                    enabled: false,
                    ..config
                }
                .validate()
                .is_err()
            );
        }
        HostResourcesConfig {
            interval_seconds: 1,
            disk_interval_seconds: 1,
            ..Default::default()
        }
        .validate()
        .unwrap();
        HostResourcesConfig {
            interval_seconds: 3600,
            disk_interval_seconds: 86400,
            ..Default::default()
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn resource_table_rejects_unknown_fields_invalid_types_and_unsigned_overflow() {
        for text in [
            "unexpected = true\n",
            "interval_seconds = 'not-an-integer'\n",
            "enabled = 1\n",
            "interval_seconds = -1\n",
            "interval_seconds = 18446744073709551616\n",
        ] {
            assert!(toml::from_str::<HostResourcesConfig>(text).is_err());
        }
    }

    #[test]
    fn all_three_overrides_can_be_set_without_a_resource_table() {
        let cli = parse(&[
            "test",
            "--host-resources-enabled",
            "true",
            "--host-resources-interval",
            "30",
            "--host-resources-disk-interval",
            "300",
        ]);
        assert_eq!(
            cli.resources.resolve(None).unwrap(),
            HostResourcesConfig {
                enabled: true,
                interval_seconds: 30,
                disk_interval_seconds: 300,
            }
        );
    }

    #[test]
    fn command_values_require_explicit_boolean_and_nonnegative_integers() {
        for args in [
            vec!["test", "--host-resources-enabled"],
            vec!["test", "--host-resources-enabled", "yes"],
            vec!["test", "--host-resources-interval", "-1"],
            vec!["test", "--host-resources-disk-interval", "not-an-integer"],
            vec!["test", "--host-resources-config", "removed.toml"],
        ] {
            assert!(
                TestCli::command()
                    .mut_args(|arg| arg.env(None::<&str>))
                    .try_get_matches_from(args)
                    .is_err()
            );
        }
    }
}
