//! Demand-driven resources of this native process and its machine.
//!
//! This entry point is independent of a network instance or Gateway. It shares
//! the existing process-wide collector and its five/sixty-second caches.

use easytier_core::instance::host_resources::HostResourcesSnapshot;

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
