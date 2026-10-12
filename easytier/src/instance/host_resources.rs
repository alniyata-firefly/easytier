//! Demand-driven resources of this native process and its machine.
//!
//! This entry point is independent of a network instance or Gateway. It shares
//! the existing process-wide collector and its configurable caches.

use easytier_core::instance::host_resources::HostResourcesSnapshot;
use std::sync::OnceLock;

mod config;
pub use config::{HostResourcesConfig, HostResourcesOptions};

static CONFIG: OnceLock<HostResourcesConfig> = OnceLock::new();

/// Install process-wide settings before RPC clients or network instances start.
/// A process restart is required to change them after sampling starts.
pub fn configure(config: HostResourcesConfig) -> anyhow::Result<()> {
    config.validate()?;
    CONFIG
        .set(config)
        .map_err(|_| anyhow::anyhow!("host resources configuration is already initialized"))
}

pub(crate) fn configuration() -> &'static HostResourcesConfig {
    CONFIG.get_or_init(HostResourcesConfig::default)
}

/// Platform capability and user enablement are reported independently.
pub fn collection_policy()
-> Option<easytier_core::instance::host_resources::HostResourceCollectionPolicy> {
    supported().then(|| {
        let config = configuration();
        easytier_core::instance::host_resources::HostResourceCollectionPolicy {
            enabled: config.enabled,
            interval_seconds: config.interval_seconds,
            disk_interval_seconds: config.disk_interval_seconds,
        }
    })
}

/// Whether this platform provides the native machine resource collector.
pub fn supported() -> bool {
    cfg!(all(target_os = "linux", not(mobile)))
}

/// Obtain resources of the calling process, not a remotely managed Core.
/// Unsupported platforms and unsuccessful sampling return no fabricated data.
pub async fn snapshot() -> Option<HostResourcesSnapshot> {
    #[cfg(all(target_os = "linux", not(mobile)))]
    {
        super::runtime_host::resources::snapshot().await
    }
    #[cfg(not(all(target_os = "linux", not(mobile))))]
    {
        None
    }
}
