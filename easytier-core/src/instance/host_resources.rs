//! Optional machine observations supplied by the embedding Host.
//!
//! These gauges describe a machine/process, not a network. Consumers must not
//! sum the same observations exported through several network instances.

use std::fmt::Write as _;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostResourceCollectionPolicy {
    pub enabled: bool,
    pub interval_seconds: u64,
    pub disk_interval_seconds: u64,
}

/// Collection configuration is separate from platform capability and readings.
pub fn append_host_resource_policy_metrics(
    text: &mut String,
    policy: Option<&HostResourceCollectionPolicy>,
) {
    let Some(policy) = policy else {
        return;
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    gauge(
        text,
        "easytier_host_resources_enabled",
        "Whether machine resource collection is enabled in this process.",
        u8::from(policy.enabled),
    );
    gauge(
        text,
        "easytier_host_resources_interval_seconds",
        "Demand-driven machine resource cache interval in seconds.",
        policy.interval_seconds,
    );
    gauge(
        text,
        "easytier_host_resources_disk_interval_seconds",
        "Demand-driven filesystem cache interval in seconds.",
        policy.disk_interval_seconds,
    );
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HostResourcesSnapshot {
    pub sampled_at_unix_ms: u64,
    /// Usage over a sampling interval, averaged across all CPUs (0..=100).
    /// The first observation has no interval and therefore no CPU value.
    pub cpu_usage_percent: Option<f64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
    pub process_rss_bytes: Option<u64>,
    pub disks: Vec<HostDiskResourcesSnapshot>,
    pub disks_sampled_at_unix_ms: Option<u64>,
    /// Component identifiers only, not OS errors, file paths or secrets.
    pub collection_errors: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostDiskResourcesSnapshot {
    pub mount_point: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

fn gauge(text: &mut String, name: &str, help: &str, value: impl std::fmt::Display) {
    let _ = writeln!(text, "# HELP {name} {help}");
    let _ = writeln!(text, "# TYPE {name} gauge");
    let _ = writeln!(text, "{name} {value}");
}

fn label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

/// Appends typed gauges without changing the existing network counter format.
/// Unknown readings are omitted, while genuine known zero readings are kept.
pub fn append_host_resource_metrics(
    text: &mut String,
    supported: bool,
    snapshot: Option<&HostResourcesSnapshot>,
) {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    gauge(
        text,
        "easytier_host_resources_supported",
        "Whether this Core Host provides machine resource observations.",
        u8::from(supported),
    );
    let Some(snapshot) = snapshot else {
        return;
    };
    gauge(
        text,
        "easytier_host_resource_sample_timestamp_seconds",
        "Unix timestamp of the CPU, memory and process resource observation.",
        snapshot.sampled_at_unix_ms as f64 / 1000.0,
    );
    if let Some(value) = snapshot
        .cpu_usage_percent
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
    {
        gauge(
            text,
            "easytier_host_cpu_usage_percent",
            "Machine CPU usage averaged across all CPUs, from zero to 100 percent.",
            value,
        );
    }
    for (name, help, value) in [
        (
            "easytier_host_memory_total_bytes",
            "Total machine RAM in bytes.",
            snapshot.memory_total_bytes,
        ),
        (
            "easytier_host_memory_available_bytes",
            "Machine RAM available to applications in bytes.",
            snapshot.memory_available_bytes,
        ),
        (
            "easytier_host_process_rss_bytes",
            "Resident memory of the Core process in bytes.",
            snapshot.process_rss_bytes,
        ),
    ] {
        if let Some(value) = value {
            gauge(text, name, help, value);
        }
    }
    if let Some(timestamp) = snapshot.disks_sampled_at_unix_ms {
        gauge(
            text,
            "easytier_host_disk_sample_timestamp_seconds",
            "Unix timestamp of the independently cached filesystem observation.",
            timestamp as f64 / 1000.0,
        );
    }
    if !snapshot.disks.is_empty() {
        for (name, help) in [
            (
                "easytier_host_disk_total_bytes",
                "Filesystem capacity in bytes.",
            ),
            (
                "easytier_host_disk_available_bytes",
                "Filesystem bytes available to unprivileged users.",
            ),
        ] {
            let _ = writeln!(text, "# HELP {name} {help}");
            let _ = writeln!(text, "# TYPE {name} gauge");
            for disk in &snapshot.disks {
                let value = if name == "easytier_host_disk_total_bytes" {
                    disk.total_bytes
                } else {
                    disk.available_bytes
                };
                let _ = writeln!(
                    text,
                    "{name}{{mount_point=\"{}\"}} {value}",
                    label(&disk.mount_point)
                );
            }
        }
    }
    text.push_str("# HELP easytier_host_resource_collection_error Whether the last observation of a component failed.\n# TYPE easytier_host_resource_collection_error gauge\n");
    for component in ["cpu", "memory", "process_rss", "disks"] {
        let failed = snapshot
            .collection_errors
            .iter()
            .any(|key| key == component);
        let _ = writeln!(
            text,
            "easytier_host_resource_collection_error{{component=\"{component}\"}} {}",
            u8::from(failed)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_policy_is_distinct_from_unsupported_platform() {
        let mut text = String::new();
        append_host_resource_metrics(&mut text, true, None);
        append_host_resource_policy_metrics(
            &mut text,
            Some(&HostResourceCollectionPolicy {
                enabled: false,
                interval_seconds: 7,
                disk_interval_seconds: 70,
            }),
        );
        assert!(text.contains("easytier_host_resources_supported 1\n"));
        assert!(text.contains("easytier_host_resources_enabled 0\n"));
        assert!(text.contains("easytier_host_resources_interval_seconds 7\n"));
        assert!(text.contains("easytier_host_resources_disk_interval_seconds 70\n"));
        assert!(!text.contains("easytier_host_memory_total_bytes"));
        let mut absent = String::new();
        append_host_resource_policy_metrics(&mut absent, None);
        assert!(absent.is_empty());
    }

    #[test]
    fn missing_resources_are_not_zero_gauges() {
        let mut text = String::new();
        append_host_resource_metrics(&mut text, false, None);
        assert!(text.contains("easytier_host_resources_supported 0\n"));
        assert!(!text.contains("easytier_host_cpu_usage_percent"));
        assert!(!text.contains("easytier_host_memory_total_bytes"));
    }

    #[test]
    fn machine_gauges_preserve_zero_escape_labels_and_separate_timestamps() {
        let mut text = "network_counter 3".to_owned();
        let snapshot = HostResourcesSnapshot {
            sampled_at_unix_ms: 20_000,
            cpu_usage_percent: Some(0.0),
            memory_total_bytes: Some(1024),
            memory_available_bytes: Some(0),
            process_rss_bytes: None,
            disks: vec![HostDiskResourcesSnapshot {
                mount_point: "/a\"b\\c\nd".to_owned(),
                total_bytes: 8192,
                available_bytes: 0,
            }],
            disks_sampled_at_unix_ms: Some(10_000),
            collection_errors: vec!["process_rss".to_owned()],
        };
        append_host_resource_metrics(&mut text, true, Some(&snapshot));
        assert!(text.starts_with("network_counter 3\n# HELP"));
        assert!(text.contains("# TYPE easytier_host_cpu_usage_percent gauge\n"));
        assert!(text.contains("easytier_host_cpu_usage_percent 0\n"));
        assert!(text.contains("easytier_host_memory_available_bytes 0\n"));
        assert!(!text.contains("easytier_host_process_rss_bytes"));
        assert!(text.contains("easytier_host_resource_sample_timestamp_seconds 20\n"));
        assert!(text.contains("easytier_host_disk_sample_timestamp_seconds 10\n"));
        assert!(text.contains("mount_point=\"/a\\\"b\\\\c\\nd\""));
        assert!(text.contains("component=\"process_rss\"} 1\n"));
        assert!(!text.contains("instance_id="));
    }

    #[test]
    fn invalid_cpu_is_not_exported() {
        for cpu in [f64::NAN, f64::INFINITY, -1.0, 101.0] {
            let mut text = String::new();
            append_host_resource_metrics(
                &mut text,
                true,
                Some(&HostResourcesSnapshot {
                    cpu_usage_percent: Some(cpu),
                    ..Default::default()
                }),
            );
            assert!(!text.contains("easytier_host_cpu_usage_percent"));
        }
    }
}
