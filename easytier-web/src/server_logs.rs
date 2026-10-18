//! Bounded, process-local observations for the administrator's server log page.
//!
//! This is deliberately a separate sink from the raw console/file logger. The
//! embedded Core and arbitrary formatted errors can contain network secrets,
//! session keys, credentials, or full configurations. Only Web events and
//! audited summaries/primitive fields are retained here.

use std::{
    collections::{BTreeMap, VecDeque},
    fmt::{self, Write as _},
    sync::Mutex,
};

use easytier::common::log::EventObserver;
use serde::{Deserialize, Serialize};
use tracing::{
    Event, Level, Metadata,
    field::{Field, Visit},
};

pub const CAPACITY: usize = 2_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ServerLogLevel {
    INFO,
    WARN,
    ERROR,
}

impl ServerLogLevel {
    fn rank(self) -> u8 {
        match self {
            Self::INFO => 0,
            Self::WARN => 1,
            Self::ERROR => 2,
        }
    }

    fn from_tracing(level: &Level) -> Option<Self> {
        match *level {
            Level::INFO => Some(Self::INFO),
            Level::WARN => Some(Self::WARN),
            Level::ERROR => Some(Self::ERROR),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ServerLogEntry {
    pub id: u64,
    pub occurred_at: i64,
    pub level: ServerLogLevel,
    pub target: String,
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerLogQuery {
    pub level: Option<ServerLogLevel>,
    pub target: Option<String>,
    pub q: Option<String>,
    pub before_id: Option<u64>,
    pub limit: Option<usize>,
}

impl ServerLogQuery {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.limit.is_some_and(|limit| limit == 0 || limit > 200) {
            return Err("limit must be between 1 and 200");
        }
        if self
            .before_id
            .is_some_and(|id| id == 0 || id > MAX_SAFE_INTEGER)
        {
            return Err("before_id must be a positive safe integer");
        }
        if self.q.as_ref().is_some_and(|q| q.chars().count() > 128) {
            return Err("q must contain at most 128 characters");
        }
        if self.target.as_ref().is_some_and(|target| {
            target.len() > 128
                || !target
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_:.-".contains(&c))
        }) {
            return Err("target must be a target prefix of at most 128 characters");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct ServerLogPage {
    pub entries: Vec<ServerLogEntry>,
    pub next_before_id: Option<u64>,
    pub instance_id: String,
    pub started_at: i64,
    pub capacity: usize,
    pub dropped_entries: u64,
    pub oldest_id: Option<u64>,
    pub newest_id: Option<u64>,
}

#[derive(Default)]
struct Buffer {
    entries: VecDeque<ServerLogEntry>,
    next_id: u64,
    dropped_entries: u64,
}

pub struct ServerLogs {
    buffer: Mutex<Buffer>,
    instance_id: String,
    started_at: i64,
    capacity: usize,
}

impl Default for ServerLogs {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerLogs {
    pub fn new() -> Self {
        Self::with_capacity(CAPACITY)
    }

    fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0);
        Self {
            buffer: Mutex::new(Buffer {
                next_id: 1,
                ..Buffer::default()
            }),
            instance_id: uuid::Uuid::new_v4().to_string(),
            started_at: chrono::Utc::now().timestamp_millis(),
            capacity,
        }
    }

    pub fn page(&self, query: &ServerLogQuery) -> Result<ServerLogPage, &'static str> {
        query.validate()?;
        let buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let search = query.q.as_deref().unwrap_or("").trim().to_lowercase();
        let limit = query.limit.unwrap_or(50);
        let mut matching = buffer.entries.iter().rev().filter(|entry| {
            query.before_id.is_none_or(|before_id| entry.id < before_id)
                && query
                    .level
                    .is_none_or(|level| entry.level.rank() >= level.rank())
                && query
                    .target
                    .as_ref()
                    .is_none_or(|target| entry.target.starts_with(target))
                && (search.is_empty()
                    || entry.message.to_lowercase().contains(&search)
                    || entry.target.to_lowercase().contains(&search)
                    || entry.fields.iter().any(|(key, value)| {
                        key.to_lowercase().contains(&search)
                            || value.to_lowercase().contains(&search)
                    }))
        });
        let entries: Vec<_> = matching.by_ref().take(limit).cloned().collect();
        let has_more = matching.next().is_some();
        Ok(ServerLogPage {
            next_before_id: has_more.then(|| entries.last().expect("nonempty page").id),
            entries,
            instance_id: self.instance_id.clone(),
            started_at: self.started_at,
            capacity: self.capacity,
            dropped_entries: buffer.dropped_entries,
            oldest_id: buffer.entries.front().map(|entry| entry.id),
            newest_id: buffer.entries.back().map(|entry| entry.id),
        })
    }

    fn retain(&self, level: ServerLogLevel, target: &str, visitor: SafeVisitor) {
        let mut buffer = self
            .buffer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // IDs stay exactly representable in the browser. Saturation is only
        // theoretical; dropping is safer than returning duplicate cursors.
        if buffer.next_id > MAX_SAFE_INTEGER {
            buffer.dropped_entries = buffer.dropped_entries.saturating_add(1);
            return;
        }
        let entry = ServerLogEntry {
            id: buffer.next_id,
            occurred_at: chrono::Utc::now().timestamp_millis(),
            level,
            target: target.to_owned(),
            message: safe_message(visitor.message.as_deref(), level).to_owned(),
            fields: visitor.fields,
        };
        buffer.next_id += 1;
        if buffer.entries.len() == self.capacity {
            buffer.entries.pop_front();
            buffer.dropped_entries = buffer.dropped_entries.saturating_add(1);
        }
        buffer.entries.push_back(entry);
    }
}

impl EventObserver for ServerLogs {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.is_event()
            && (metadata.target() == "easytier_web"
                || metadata.target().starts_with("easytier_web::"))
            && ServerLogLevel::from_tracing(metadata.level()).is_some()
    }

    fn on_event(&self, event: &Event<'_>) {
        if !self.enabled(event.metadata()) {
            return;
        }
        let mut visitor = SafeVisitor::default();
        event.record(&mut visitor);
        self.retain(
            ServerLogLevel::from_tracing(event.metadata().level()).expect("enabled level"),
            event.metadata().target(),
            visitor,
        );
    }
}

/// Never keep arbitrary formatted text, including interpolations in `message`.
/// New call sites remain visible through their level/target and a safe fallback
/// until their static summary is reviewed here.
fn safe_message(message: Option<&str>, level: ServerLogLevel) -> &'static str {
    let message = message.unwrap_or("");
    const EXACT: &[&str] = &[
        "easytier-web starting",
        "easytier-web ready",
        "easytier-web stopping",
        "Database not found, creating a new one",
        "configuration listener address family unavailable",
        "management connection event could not be persisted",
        "management configuration event could not be persisted",
        "management authorization event could not be persisted",
        "management authentication event could not be persisted",
        "failed to publish central network configs",
        "central configs will be retried",
        "central device config will be retried",
        "failed to accept secure tunnel, dropping connection",
        "secure tunnel handshake task failed",
        "node-connected webhook delivery completed",
        "node-connected webhook delivery failed",
        "node-disconnected webhook delivery failed",
        "node-disconnected webhook returned failure status",
        "node-disconnected webhook completed slowly",
        "skip node-disconnected webhook because webhook_url is not configured",
        "validate-token completed slowly",
        "session disconnected",
        "session identity established",
        "heartbeat failed instance set changed",
        "webhook validation failed, will retry later",
        "webhook connection transition task failed",
        "webhook token rejected; marking session invalid and requiring client reconnect",
        "webhook validation stopped for invalid session; reconnect is required before revalidation",
        "ignore webhook validation success for invalid session; reconnect is required before revalidation",
        "webhook session is invalid; failing heartbeat to require client reconnect",
        "Failed to receive heartbeat request: channel closed",
        "Failed to get storage",
        "Machine id is not set, ignore",
        "Heartbeat succeeded before session token was initialized",
        "Managed config dirty instance is no longer a web-owned row; using Full reconcile",
        "Stale managed instances were retained by the runtime",
        "Managed config Patch deletion was retained by the runtime",
        "managed config revision applied",
        "Gateway connection task failed",
        "failed to accept Gateway peer tunnel",
        "Gateway network unavailable, dropping connection",
        "failed to demultiplex tunnel, dropping connection",
        "Registration attempt blocked: registration is disabled",
        "HTTP client not initialized in OIDC config",
        "Access token hash mismatch",
        "Failed to get signing algorithm or key for at_hash verification",
        "Exception occurs during clearing the session.",
        "Unable to find the specified font.",
    ];
    if let Some(summary) = EXACT.iter().find(|summary| **summary == message) {
        return summary;
    }
    // These existing call sites interpolate arbitrary error/RPC/config output.
    // Strip the entire suffix rather than attempting to redact secret patterns.
    const PREFIXES: &[(&str, &str)] = &[
        ("New session from ", "New management session accepted"),
        (
            "Successfully loaded GeoIP2 database from ",
            "GeoIP2 database loaded",
        ),
        ("Auto-created user '", "User auto-created"),
        ("Auto-provisioned OIDC user '", "OIDC user auto-provisioned"),
        ("Failed to handle heartbeat: ", "Failed to handle heartbeat"),
        (
            "Failed to list network configs, error: ",
            "Failed to list network configs",
        ),
        (
            "Failed to load managed config Patch rows, error: ",
            "Failed to load managed config Patch rows",
        ),
        (
            "Failed to read managed config revision, error: ",
            "Failed to read managed config revision",
        ),
        (
            "Failed to list all network configs, error: ",
            "Failed to list all network configs",
        ),
        (
            "Clean stale web-source network instances on heartbeat: ",
            "Clean stale web-source network instances on heartbeat",
        ),
        (
            "Apply managed config Patch deletions at runtime: ",
            "Apply managed config Patch deletions at runtime",
        ),
        (
            "Reconcile running web-source network instance: ",
            "Reconcile running web-source network instance",
        ),
        ("Run network instance: ", "Run network instance"),
        (
            "failed to hot-update Gateway credentials: ",
            "Failed to update Gateway credentials",
        ),
        (
            "failed to build Gateway runtime: ",
            "Failed to build Gateway runtime",
        ),
        (
            "failed to start Gateway runtime: ",
            "Failed to start Gateway runtime",
        ),
        ("Failed to change password: ", "Failed to change password"),
        (
            "Failed to register new user: ",
            "Failed to register new user",
        ),
        ("Failed to logout: ", "Failed to logout"),
        (
            "Failed to store csrf_token in session: ",
            "Failed to store OIDC session state",
        ),
        (
            "Failed to store nonce in session: ",
            "Failed to store OIDC session state",
        ),
        (
            "Failed to store pkce_verifier in session: ",
            "Failed to store OIDC session state",
        ),
        (
            "Failed to store pkce_used in session: ",
            "Failed to store OIDC session state",
        ),
        (
            "Failed to create token request: ",
            "Failed to create OIDC token request",
        ),
        (
            "Failed to exchange code for token: ",
            "Failed to exchange OIDC token",
        ),
        (
            "Failed to verify ID token: ",
            "Failed to verify OIDC ID token",
        ),
        (
            "Failed to compute access token hash: ",
            "Failed to compute OIDC token hash",
        ),
        (
            "Failed to serialize claims: ",
            "Failed to serialize OIDC claims",
        ),
        (
            "Failed to find or create OIDC user '",
            "Failed to provision OIDC user",
        ),
        (
            "Failed to login user via OIDC: ",
            "Failed to login OIDC user",
        ),
        (
            "Failed to cycle session ID after OIDC login: ",
            "Failed to rotate OIDC session",
        ),
    ];
    PREFIXES
        .iter()
        .find_map(|(prefix, summary)| message.starts_with(prefix).then_some(*summary))
        .unwrap_or(match level {
            ServerLogLevel::INFO => "Server informational event (details omitted)",
            ServerLogLevel::WARN => "Server warning (details omitted)",
            ServerLogLevel::ERROR => "Server error (details omitted)",
        })
}

#[derive(Default)]
struct SafeVisitor {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

fn numeric_field(name: &str) -> bool {
    matches!(
        name,
        "user_id"
            | "peer_id"
            | "session_epoch"
            | "binding_version"
            | "attempt"
            | "elapsed_ms"
            | "queue_ms"
            | "http_ms"
            | "api_port"
            | "config_port"
            | "heartbeat_min_response_ms"
            | "heartbeat_timeout_ms"
            | "device_count"
            | "network_count"
            | "forward_count"
            | "status_code"
    )
}

fn boolean_field(name: &str) -> bool {
    matches!(
        name,
        "success"
            | "will_retry"
            | "pending_rebind"
            | "webhook_enabled"
            | "rust_log_override"
            | "console_log_override"
            | "secure"
    )
}

fn text_field(name: &str) -> bool {
    matches!(
        name,
        "machine_id"
            | "device_id"
            | "instance_id"
            | "network_id"
            | "web_instance_id"
            | "version"
            | "config_protocol"
            | "protocol"
    )
}

impl SafeVisitor {
    fn text(&mut self, name: &str, value: &str) {
        let valid = match name {
            "machine_id" | "device_id" | "instance_id" | "network_id" | "web_instance_id" => {
                uuid::Uuid::parse_str(value).is_ok()
            }
            "config_protocol" | "protocol" => {
                matches!(value, "udp" | "tcp" | "ws" | "wss" | "quic")
            }
            "version" => {
                value.len() <= 80
                    && value.starts_with(|c: char| c.is_ascii_digit())
                    && value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-_".contains(&c))
            }
            _ if numeric_field(name) => value.parse::<u64>().is_ok(),
            _ => false,
        };
        if valid {
            self.fields.insert(name.to_owned(), value.to_owned());
        }
    }
}

/// Formatting an untrusted error must not allocate an unbounded temporary.
#[derive(Default)]
struct BoundedText(String);

impl fmt::Write for BoundedText {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let remaining = 2_048usize.saturating_sub(self.0.len());
        let mut end = text.len().min(remaining);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.0.push_str(&text[..end]);
        if end < text.len() {
            Err(fmt::Error)
        } else {
            Ok(())
        }
    }
}

impl Visit for SafeVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            let mut text = BoundedText::default();
            let _ = text.write_str(value);
            self.message = Some(text.0);
        } else if text_field(field.name()) || numeric_field(field.name()) {
            self.text(field.name(), value);
        }
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        if numeric_field(field.name()) {
            self.fields
                .insert(field.name().to_owned(), value.to_string());
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        if value >= 0 {
            self.record_u64(field, value as u64);
        }
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        if boolean_field(field.name()) {
            self.fields
                .insert(field.name().to_owned(), value.to_string());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if field.name() == "message" || text_field(field.name()) || numeric_field(field.name()) {
            let mut text = BoundedText::default();
            let _ = write!(text, "{value:?}");
            if field.name() == "message" {
                self.message = Some(text.0);
            } else {
                self.text(field.name(), &text.0);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    use tracing::{
        Subscriber,
        span::{Attributes, Id, Record},
        subscriber::Interest,
    };

    struct ObserverSubscriber(Arc<ServerLogs>, AtomicU64);
    impl Subscriber for ObserverSubscriber {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            self.0.enabled(metadata)
        }
        fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
            Interest::sometimes()
        }
        fn new_span(&self, _: &Attributes<'_>) -> Id {
            Id::from_u64(self.1.fetch_add(1, Ordering::Relaxed) + 1)
        }
        fn record(&self, _: &Id, _: &Record<'_>) {}
        fn record_follows_from(&self, _: &Id, _: &Id) {}
        fn event(&self, event: &Event<'_>) {
            self.0.on_event(event);
        }
        fn enter(&self, _: &Id) {}
        fn exit(&self, _: &Id) {}
    }

    pub(crate) fn capture(logs: Arc<ServerLogs>, run: impl FnOnce()) {
        tracing::subscriber::with_default(ObserverSubscriber(logs, AtomicU64::new(0)), run);
    }

    #[test]
    fn actual_events_keep_useful_summaries_and_never_keep_secrets_or_core_events() {
        let logs = Arc::new(ServerLogs::new());
        let secret = "canary-network-secret-DO-NOT-RETAIN";
        let id = uuid::Uuid::new_v4();
        capture(logs.clone(), || {
            tracing::info!(target: "easytier_web", version = "2.7.2-v2.7.2-10-g60f7e002", api_port = 11211, webhook_enabled = true, "easytier-web starting");
            tracing::warn!(target: "easytier_web::client_manager", machine_id = %id, user_id = 17, error = secret, network_secret = secret, token = secret, config = ?vec![secret], "Failed to handle heartbeat: {secret}");
            tracing::error!(target: "easytier_web::restful", user_id = secret, machine_id = secret, version = secret, protocol = secret, "arbitrary dynamic detail {secret}");
            tracing::info!(target: "easytier_web::client_manager", "session identity established");
            tracing::debug!(target: "easytier_web", "session key {secret}");
            tracing::error!(target: "CORE", "root_key {secret}");
            tracing::error!(target: "easytier_core::peers", "root_key {secret}");
            tracing::error!(target: "easytier_web_unrelated", "root_key {secret}");
        });
        let page = logs.page(&ServerLogQuery::default()).unwrap();
        assert_eq!(page.entries.len(), 4);
        assert_eq!(page.entries[3].message, "easytier-web starting");
        assert_eq!(page.entries[2].message, "Failed to handle heartbeat");
        assert_eq!(
            page.entries[2].fields.get("machine_id"),
            Some(&id.to_string())
        );
        assert_eq!(
            page.entries[2].fields.get("user_id"),
            Some(&"17".to_owned())
        );
        assert!(page.entries[1].fields.is_empty());
        let serialized = serde_json::to_string(&page).unwrap();
        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("network_secret"));
        assert!(!serialized.contains("root_key"));
        assert!(!serialized.contains("\"config\""));
    }

    #[test]
    fn spoofed_summary_prefixes_and_sensitive_debug_fields_never_return_raw_values() {
        struct MustNotFormat;
        impl fmt::Debug for MustNotFormat {
            fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                panic!("sensitive debug fields must be ignored without formatting");
            }
        }
        let logs = Arc::new(ServerLogs::new());
        let secret = "CANARY-credential\nnetwork_secret=also-secret";
        capture(logs.clone(), || {
            tracing::warn!(target: "easytier_web::client_manager", password = ?MustNotFormat, error = ?MustNotFormat, config = ?MustNotFormat, "session disconnected {secret}");
            tracing::info!(target: "easytier_web::client_manager", success = false, "Run network instance: {secret}");
            tracing::info!(target: "easytier_web::restful", "Auto-provisioned OIDC user '{secret}'");
            tracing::info!(target: "easytier_web::client_manager", "session identity established\0{secret}");
        });
        let page = logs.page(&ServerLogQuery::default()).unwrap();
        assert_eq!(page.entries.len(), 4);
        assert_eq!(page.entries[3].message, "Server warning (details omitted)");
        assert_eq!(page.entries[2].message, "Run network instance");
        assert_eq!(
            page.entries[2].fields.get("success"),
            Some(&"false".to_owned())
        );
        assert_eq!(page.entries[1].message, "OIDC user auto-provisioned");
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("CANARY"));
        assert!(!json.contains("network_secret"));
        assert!(!json.contains("password"));
    }

    #[test]
    fn bounded_retention_filtering_and_pagination_stay_stable_while_new_entries_arrive() {
        let logs = Arc::new(ServerLogs::with_capacity(4));
        capture(logs.clone(), || {
            tracing::info!(target: "easytier_web", "easytier-web starting");
            tracing::warn!(target: "easytier_web::auth", "session disconnected");
            tracing::error!(target: "easytier_web::auth", "Failed to get storage");
            tracing::warn!(target: "easytier_web::auth", "session disconnected");
            tracing::info!(target: "easytier_web", "easytier-web ready");
        });
        let first = logs
            .page(&ServerLogQuery {
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            first
                .entries
                .iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>(),
            vec![5, 4]
        );
        assert_eq!(first.next_before_id, Some(4));
        assert_eq!(first.dropped_entries, 1);
        assert_eq!((first.oldest_id, first.newest_id), (Some(2), Some(5)));
        capture(
            logs.clone(),
            || tracing::info!(target: "easytier_web", "easytier-web ready"),
        );
        let older = logs
            .page(&ServerLogQuery {
                before_id: first.next_before_id,
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            older
                .entries
                .iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>(),
            vec![3]
        );
        assert_eq!(older.next_before_id, None);
        let filtered = logs
            .page(&ServerLogQuery {
                level: Some(ServerLogLevel::WARN),
                target: Some("easytier_web::auth".into()),
                q: Some("STORAGE".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.entries.len(), 1);
        assert_eq!(filtered.entries[0].level, ServerLogLevel::ERROR);
        assert_eq!(filtered.instance_id, first.instance_id);
        assert_ne!(ServerLogs::new().instance_id, logs.instance_id);
    }

    #[test]
    fn invalid_bounds_and_unreviewed_messages_do_not_escape() {
        for query in [
            ServerLogQuery {
                limit: Some(0),
                ..Default::default()
            },
            ServerLogQuery {
                limit: Some(201),
                ..Default::default()
            },
            ServerLogQuery {
                before_id: Some(0),
                ..Default::default()
            },
            ServerLogQuery {
                before_id: Some(MAX_SAFE_INTEGER + 1),
                ..Default::default()
            },
            ServerLogQuery {
                q: Some("中".repeat(129)),
                ..Default::default()
            },
            ServerLogQuery {
                target: Some("bad\nheader".into()),
                ..Default::default()
            },
        ] {
            assert!(query.validate().is_err());
        }
        assert_eq!(
            safe_message(
                Some("session disconnected token=secret"),
                ServerLogLevel::WARN
            ),
            "Server warning (details omitted)"
        );
        assert_eq!(
            safe_message(
                Some("Run network instance: secret=123"),
                ServerLogLevel::INFO
            ),
            "Run network instance"
        );
        let mut bounded = BoundedText::default();
        let _ = bounded.write_str(&"密".repeat(10_000));
        assert!(bounded.0.len() <= 2_048);
    }

    #[test]
    fn concurrent_producers_share_one_bounded_monotonic_cursor() {
        let logs = Arc::new(ServerLogs::with_capacity(32));
        let producers: Vec<_> = (0..8)
            .map(|_| {
                let logs = logs.clone();
                std::thread::spawn(move || {
                    capture(logs, || {
                        for _ in 0..50 {
                            tracing::info!(target: "easytier_web", "session identity established");
                        }
                    })
                })
            })
            .collect();
        for producer in producers {
            producer.join().unwrap();
        }
        let page = logs
            .page(&ServerLogQuery {
                limit: Some(200),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.entries.len(), 32);
        assert_eq!(page.dropped_entries, 368);
        assert_eq!((page.oldest_id, page.newest_id), (Some(369), Some(400)));
        assert!(
            page.entries
                .windows(2)
                .all(|entries| entries[0].id == entries[1].id + 1)
        );
    }
}
