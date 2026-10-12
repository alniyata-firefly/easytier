//! Linux machine sampling shared by every native instance in this process.
//!
//! Sampling is demand driven. File I/O and statvfs run on the blocking pool;
//! an owned mutex stays with that job even if the requesting RPC is canceled.

use std::{
    collections::BTreeMap,
    os::unix::ffi::OsStringExt,
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use easytier_core::instance::host_resources::{HostDiskResourcesSnapshot, HostResourcesSnapshot};
use tokio::sync::Mutex;

const RESOURCE_CACHE_TTL: Duration = Duration::from_secs(5);
const DISK_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CpuCounters {
    total: u64,
    idle: u64,
}

#[derive(Default)]
struct CollectorState {
    snapshot: Option<HostResourcesSnapshot>,
    last_sample_at: Option<Instant>,
    previous_cpu: Option<CpuCounters>,
    last_disk_attempt_at: Option<Instant>,
    disks: Vec<HostDiskResourcesSnapshot>,
    disks_sampled_at_unix_ms: Option<u64>,
    disks_failed: bool,
}

#[derive(Default)]
struct ResourceCollector {
    state: Arc<Mutex<CollectorState>>,
}

static COLLECTOR: OnceLock<ResourceCollector> = OnceLock::new();

pub(super) async fn snapshot() -> Option<HostResourcesSnapshot> {
    COLLECTOR
        .get_or_init(ResourceCollector::default)
        .snapshot()
        .await
}

impl ResourceCollector {
    async fn snapshot(&self) -> Option<HostResourcesSnapshot> {
        let mut state = self.state.clone().lock_owned().await;
        if state
            .last_sample_at
            .is_some_and(|at| at.elapsed() < RESOURCE_CACHE_TTL)
        {
            return state.snapshot.clone();
        }
        tokio::task::spawn_blocking(move || {
            let mut snapshot = HostResourcesSnapshot::default();

            // Filesystem scans may be slower than /proc reads. Complete them
            // first, with their own timestamp, so the subsequent CPU/memory
            // timestamp reflects the observation rather than disk latency.
            if state
                .last_disk_attempt_at
                .is_none_or(|at| at.elapsed() >= DISK_CACHE_TTL)
            {
                state.last_disk_attempt_at = Some(Instant::now());
                match sample_disks() {
                    Ok((disks, partial_failure)) => {
                        state.disks = disks;
                        state.disks_sampled_at_unix_ms = Some(unix_ms());
                        state.disks_failed = partial_failure;
                    }
                    Err(()) => {
                        // Keep the last disk sample's original timestamp. A
                        // failed refresh must never make an old value fresh.
                        state.disks_failed = true;
                    }
                }
            }

            match std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|text| cpu_counters(&text))
            {
                Some(current) => {
                    snapshot.cpu_usage_percent = state
                        .previous_cpu
                        .and_then(|previous| cpu_usage(previous, current));
                    state.previous_cpu = Some(current);
                }
                None => {
                    state.previous_cpu = None;
                    snapshot.collection_errors.push("cpu".to_owned());
                }
            }

            let memory = std::fs::read_to_string("/proc/meminfo")
                .ok()
                .map(|text| memory_bytes(&text))
                .unwrap_or_default();
            snapshot.memory_total_bytes = memory.0;
            snapshot.memory_available_bytes = memory.1;
            if memory.0.is_none() || memory.1.is_none() {
                snapshot.collection_errors.push("memory".to_owned());
            }

            snapshot.process_rss_bytes = std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|text| field_kib_bytes(&text, "VmRSS:"));
            if snapshot.process_rss_bytes.is_none() {
                snapshot.collection_errors.push("process_rss".to_owned());
            }

            snapshot.disks.clone_from(&state.disks);
            snapshot.disks_sampled_at_unix_ms = state.disks_sampled_at_unix_ms;
            if state.disks_failed {
                snapshot.collection_errors.push("disks".to_owned());
            }
            snapshot.sampled_at_unix_ms = unix_ms();
            state.last_sample_at = Some(Instant::now());
            state.snapshot = Some(snapshot.clone());
            snapshot
        })
        .await
        .ok()
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| duration.as_millis().try_into().ok())
        .unwrap_or_default()
}

fn cpu_counters(text: &str) -> Option<CpuCounters> {
    let mut fields = text
        .lines()
        .find(|line| line.starts_with("cpu "))?
        .split_whitespace();
    fields.next()?;
    // Linux guest/guest_nice are already included in user/nice. Summing them
    // again would overcount busy time and distort the machine percentage.
    let counters = fields
        .take(8)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if counters.len() < 4 {
        return None;
    }
    let total = counters
        .iter()
        .try_fold(0u64, |sum, value| sum.checked_add(*value))?;
    let idle = counters[3].checked_add(counters.get(4).copied().unwrap_or_default())?;
    (idle <= total).then_some(CpuCounters { total, idle })
}

fn cpu_usage(previous: CpuCounters, current: CpuCounters) -> Option<f64> {
    let total = current.total.checked_sub(previous.total)?;
    let idle = current.idle.checked_sub(previous.idle)?;
    if total == 0 || idle > total {
        return None;
    }
    Some((total - idle) as f64 / total as f64 * 100.0)
}

fn field_kib_bytes(text: &str, key: &str) -> Option<u64> {
    let mut fields = text
        .lines()
        .find(|line| line.split_whitespace().next() == Some(key))?
        .split_whitespace();
    fields.next()?;
    let value = fields.next()?.parse::<u64>().ok()?;
    (fields.next()? == "kB")
        .then(|| value.checked_mul(1024))
        .flatten()
}

fn memory_bytes(text: &str) -> (Option<u64>, Option<u64>) {
    let total = field_kib_bytes(text, "MemTotal:").filter(|value| *value > 0);
    let available = field_kib_bytes(text, "MemAvailable:");
    let available = available.filter(|value| total.is_none_or(|total| *value <= total));
    (total, available)
}

#[derive(Debug, PartialEq, Eq)]
struct Mount {
    device: String,
    root: PathBuf,
    mount_point: PathBuf,
}

fn decode_mount_path(path: &str) -> PathBuf {
    let mut decoded = Vec::with_capacity(path.len());
    let bytes = path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\'
            && index + 3 < bytes.len()
            && (b'0'..=b'3').contains(&bytes[index + 1])
            && bytes[index + 1..index + 4]
                .iter()
                .all(|byte| (b'0'..=b'7').contains(byte))
        {
            decoded.push(
                (bytes[index + 1] - b'0') * 64 + (bytes[index + 2] - b'0') * 8 + bytes[index + 3]
                    - b'0',
            );
            index += 4;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    PathBuf::from(std::ffi::OsString::from_vec(decoded))
}

fn local_filesystem(fs: &str) -> bool {
    // Exclude proc/sysfs/tmpfs and network/FUSE filesystems: a remote statvfs
    // can block indefinitely, and virtual memory filesystems are not disks.
    matches!(
        fs,
        "ext2"
            | "ext3"
            | "ext4"
            | "xfs"
            | "btrfs"
            | "zfs"
            | "f2fs"
            | "vfat"
            | "exfat"
            | "ntfs"
            | "ntfs3"
            | "reiserfs"
            | "jfs"
            | "ufs"
            | "overlay"
            | "bcachefs"
            | "ubifs"
            | "jffs2"
            | "squashfs"
    )
}

fn mounts(text: &str) -> Vec<Mount> {
    let mut by_device: BTreeMap<String, Mount> = BTreeMap::new();
    for line in text.lines() {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            continue;
        };
        if !filesystem
            .split_whitespace()
            .next()
            .is_some_and(local_filesystem)
        {
            continue;
        }
        let fields: Vec<_> = mount.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let candidate = Mount {
            device: fields[2].to_owned(),
            root: decode_mount_path(fields[3]),
            mount_point: decode_mount_path(fields[4]),
        };
        if !candidate.mount_point.is_absolute() {
            continue;
        }
        let replace = by_device.get(&candidate.device).is_none_or(|current| {
            // Prefer the whole filesystem mount over bind mounts, then its
            // shortest canonical mount point. Report each device only once.
            (
                candidate.root != std::path::Path::new("/"),
                candidate.mount_point.as_os_str().len(),
            ) < (
                current.root != std::path::Path::new("/"),
                current.mount_point.as_os_str().len(),
            )
        });
        if replace {
            by_device.insert(candidate.device.clone(), candidate);
        }
    }
    let mut result: Vec<_> = by_device.into_values().collect();
    result.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));
    result
}

fn sample_disks() -> Result<(Vec<HostDiskResourcesSnapshot>, bool), ()> {
    let text = std::fs::read_to_string("/proc/self/mountinfo").map_err(|_| ())?;
    let mut disks = Vec::new();
    let mut partial_failure = false;
    for mount in mounts(&text) {
        let Ok(stat) = nix::sys::statvfs::statvfs(&mount.mount_point) else {
            partial_failure = true;
            continue;
        };
        let (Some(total_bytes), Some(available_bytes)) = (
            filesystem_bytes(stat.blocks(), stat.fragment_size()),
            filesystem_bytes(stat.blocks_available(), stat.fragment_size()),
        ) else {
            partial_failure = true;
            continue;
        };
        if total_bytes == 0 || available_bytes > total_bytes {
            continue;
        }
        disks.push(HostDiskResourcesSnapshot {
            mount_point: mount.mount_point.to_string_lossy().into_owned(),
            total_bytes,
            available_bytes,
        });
    }
    Ok((disks, partial_failure))
}

// fsblkcnt_t and c_ulong differ on 32-bit Linux. Normalize both operands
// without truncating a filesystem's capacity or relying on the native word size.
fn filesystem_bytes(blocks: impl Into<u64>, fragment_size: impl Into<u64>) -> Option<u64> {
    blocks.into().checked_mul(fragment_size.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_interval_does_not_count_guest_twice_or_invent_first_sample() {
        let before = cpu_counters("cpu 100 20 30 400 50 10 20 70 900 800\ncpu0 1 2 3 4").unwrap();
        assert_eq!(
            before,
            CpuCounters {
                total: 700,
                idle: 450
            }
        );
        let after = cpu_counters("cpu 120 20 50 410 60 10 30 100 990 850").unwrap();
        assert_eq!(cpu_usage(before, after), Some(80.0));
        assert_eq!(cpu_usage(before, before), None);
        assert_eq!(cpu_usage(after, before), None);
        assert_eq!(cpu_counters("cpu0 1 2 3 4"), None);
        assert_eq!(cpu_counters("cpu 1 2 broken 4"), None);
    }

    #[test]
    fn ram_and_rss_unknown_and_overflow_stay_unknown() {
        assert_eq!(
            memory_bytes("MemTotal: 4096 kB\nMemAvailable: 1024 kB"),
            (Some(4_194_304), Some(1_048_576))
        );
        assert_eq!(memory_bytes("MemTotal: 4096 kB"), (Some(4_194_304), None));
        assert_eq!(
            memory_bytes("MemTotal: 1 kB\nMemAvailable: 2 kB"),
            (Some(1024), None)
        );
        assert_eq!(field_kib_bytes("VmRSS: 0 kB", "VmRSS:"), Some(0));
        assert_eq!(
            field_kib_bytes("VmRSS: 18446744073709551615 kB", "VmRSS:"),
            None
        );
        assert_eq!(field_kib_bytes("VmRSS: 15 bytes", "VmRSS:"), None);
    }

    #[test]
    fn mounts_exclude_virtual_remote_and_duplicate_filesystems() {
        let input = "1 0 8:1 /sub /data/bind rw - ext4 /dev/sda rw\n2 0 8:1 / /data rw - ext4 /dev/sda rw\n3 0 8:2 / / rw - ext4 /dev/sdb rw\n4 0 0:1 / /proc rw - proc proc rw\n5 0 0:2 / /memory rw - tmpfs tmpfs rw\n6 0 0:3 / /remote rw - nfs server:/a rw\n7 0 8:3 / /space\\040disk rw - xfs /dev/sdc rw";
        let result = mounts(input);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].mount_point, PathBuf::from("/"));
        assert_eq!(result[1].mount_point, PathBuf::from("/data"));
        assert_eq!(result[2].mount_point, PathBuf::from("/space disk"));
    }

    #[test]
    fn filesystem_size_handles_32_bit_sizes_and_overflow() {
        assert_eq!(filesystem_bytes(3u64, 4096u32), Some(12_288));
        assert_eq!(filesystem_bytes(3u32, 4096u64), Some(12_288));
        assert_eq!(filesystem_bytes(u64::MAX, 4096u32), None);
        assert_eq!(filesystem_bytes(0u32, 4096u32), Some(0));
        assert_eq!(
            decode_mount_path("/invalid\\777"),
            PathBuf::from("/invalid\\777")
        );
        assert_eq!(
            decode_mount_path("/line\\012tab\\011"),
            PathBuf::from("/line\ntab\t")
        );
    }

    #[tokio::test]
    async fn concurrent_queries_share_samples_and_disk_cache() {
        let collector = ResourceCollector::default();
        let (a, b) = tokio::join!(collector.snapshot(), collector.snapshot());
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a, b);
        assert_eq!(a.cpu_usage_percent, None);
        assert!(a.sampled_at_unix_ms > 0);
        assert!(a.memory_total_bytes.is_some());
        assert!(a.process_rss_bytes.is_some());
        assert!(!a.disks.is_empty());
        assert!(a.collection_errors.is_empty());
        {
            // Expire only the general cache: the CPU gets a real interval,
            // but disks keep their independent original observation time.
            let mut state = collector.state.lock().await;
            state.last_sample_at = Some(Instant::now() - RESOURCE_CACHE_TTL);
        }
        let refreshed = collector.snapshot().await.unwrap();
        assert_eq!(
            refreshed.disks_sampled_at_unix_ms,
            a.disks_sampled_at_unix_ms
        );
        assert_eq!(refreshed.disks, a.disks);
        if let Some(cpu) = refreshed.cpu_usage_percent {
            assert!((0.0..=100.0).contains(&cpu));
        }
    }
}
