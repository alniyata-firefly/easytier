//! Optional, tenant-scoped history and a separate read-only metrics collector.
//!
//! A collector bearer credential never enters the management/internal routers.
//! Query expressions, storage URLs and scrape destinations are server-owned.
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, State},
    http::{Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use easytier_core::management::remote_client::Storage as _;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq as _;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    central_network::service::CentralNetworkService,
    client_manager::{ClientManager, session::Session},
    db::{Db, UserIdInDb},
};

use super::{AppState, HttpHandleError, authed_user_id, convert_db_error, other_error};

const MIN_STEP: u64 = 15;
const MAX_RANGE: u64 = 31 * 24 * 60 * 60;
const MAX_POINTS: u64 = 2000;
const MAX_SERIES: usize = 64;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCRAPE_BYTES: usize = 4 * 1024 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Default, clap::Args)]
pub(crate) struct MetricsOptions {
    /// VictoriaMetrics/Prometheus API base URL. History is disabled if unset.
    #[arg(long, env = "ET_METRICS_HISTORY_URL")]
    pub metrics_history_url: Option<String>,
    /// Optional bearer-token file for the history backend; never exposed to browsers.
    #[arg(long, env = "ET_METRICS_HISTORY_TOKEN_FILE")]
    pub metrics_history_token_file: Option<PathBuf>,
    /// Stable unique installation ID, required when history or collection is enabled.
    #[arg(long, env = "ET_METRICS_WEB_ID")]
    pub metrics_web_id: Option<String>,
    /// Read-only collector token file (at least 32 characters; mode 0600 on Unix).
    #[arg(long, env = "ET_METRICS_COLLECTOR_TOKEN_FILE")]
    pub metrics_collector_token_file: Option<PathBuf>,
    /// The only owner whose authorized devices this collector may read.
    #[arg(long, env = "ET_METRICS_COLLECTOR_USER_ID")]
    pub metrics_collector_user_id: Option<UserIdInDb>,
    /// Explicit reachable Web API base URL for HTTP service discovery.
    #[arg(long, env = "ET_METRICS_COLLECTOR_BASE_URL")]
    pub metrics_collector_base_url: Option<String>,
}

impl std::fmt::Debug for MetricsOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MetricsOptions")
            .field("history_enabled", &self.metrics_history_url.is_some())
            .field("collector_user_id", &self.metrics_collector_user_id)
            .field("web_id", &self.metrics_web_id)
            .finish_non_exhaustive()
    }
}

struct Collector {
    token_digest: [u8; 32],
    user_id: UserIdInDb,
    base_url: url::Url,
}

pub(crate) struct Observability {
    web_id: String,
    history_url: Option<url::Url>,
    history_token: Option<String>,
    collector: Option<Collector>,
    client: reqwest::Client,
    query_permits: Semaphore,
}

impl std::fmt::Debug for Observability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Observability")
            .field("web_id", &self.web_id)
            .field("history_enabled", &self.history_url.is_some())
            .field("collector_enabled", &self.collector.is_some())
            .finish_non_exhaustive()
    }
}

fn validated_base_url(value: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid metrics HTTP URL"))?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "metrics URLs require http/https and a host, without credentials, query or fragment"
    );
    Ok(url)
}

fn read_secret(path: &std::path::Path, minimum: usize) -> anyhow::Result<String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| anyhow::anyhow!("cannot read metrics token file"))?;
    anyhow::ensure!(
        metadata.is_file() && metadata.len() <= 8192,
        "invalid metrics token file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        anyhow::ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "metrics token file must not be accessible by group or other users"
        );
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| anyhow::anyhow!("cannot read metrics token file"))?;
    let token = text.trim();
    anyhow::ensure!(
        token.len() >= minimum && token.len() <= 8192 && !token.chars().any(char::is_whitespace),
        "invalid metrics token length or whitespace"
    );
    Ok(token.to_owned())
}

fn digest(value: &str) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest(value.as_bytes()).into()
}

impl Observability {
    pub(crate) fn from_options(options: MetricsOptions) -> anyhow::Result<Self> {
        let enabled =
            options.metrics_history_url.is_some() || options.metrics_collector_token_file.is_some();
        let web_id = options.metrics_web_id.unwrap_or_default();
        anyhow::ensure!(
            !enabled
                || (!web_id.is_empty()
                    && web_id.len() <= 64
                    && web_id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))),
            "--metrics-web-id is required and must contain 1..64 letters, digits, dots, underscores or hyphens"
        );
        anyhow::ensure!(
            options.metrics_history_token_file.is_none() || options.metrics_history_url.is_some(),
            "history token requires --metrics-history-url"
        );
        let history_url = options
            .metrics_history_url
            .as_deref()
            .map(validated_base_url)
            .transpose()?;
        let history_token = options
            .metrics_history_token_file
            .as_deref()
            .map(|path| read_secret(path, 1))
            .transpose()?;
        let collector = match (
            options.metrics_collector_token_file,
            options.metrics_collector_user_id,
            options.metrics_collector_base_url,
        ) {
            (None, None, None) => None,
            (Some(path), Some(user_id), Some(base_url)) if user_id > 0 => Some(Collector {
                token_digest: digest(&read_secret(&path, 32)?),
                user_id,
                base_url: validated_base_url(&base_url)?,
            }),
            _ => anyhow::bail!(
                "collector requires token file, a positive user ID and explicit base URL together"
            ),
        };
        Ok(Self {
            web_id,
            history_url,
            history_token,
            collector,
            client: reqwest::Client::builder()
                .timeout(QUERY_TIMEOUT)
                .connect_timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
            query_permits: Semaphore::new(8),
        })
    }

    fn collector_authorized(&self, headers: &axum::http::HeaderMap) -> bool {
        let Some(collector) = &self.collector else {
            return false;
        };
        let Some(token) = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
        else {
            return false;
        };
        token.len() <= 8192 && bool::from(digest(token).ct_eq(&collector.token_digest))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum HistoryMetric {
    TrafficTxRate,
    TrafficRxRate,
    TrafficTxBytes,
    TrafficRxBytes,
    RpcErrorRate,
    HostCpuPercent,
    HostMemoryUsedBytes,
    HostProcessRssBytes,
    HostDiskUsedBytes,
}

const METRICS: &[HistoryMetric] = &[
    HistoryMetric::TrafficTxRate,
    HistoryMetric::TrafficRxRate,
    HistoryMetric::TrafficTxBytes,
    HistoryMetric::TrafficRxBytes,
    HistoryMetric::RpcErrorRate,
    HistoryMetric::HostCpuPercent,
    HistoryMetric::HostMemoryUsedBytes,
    HistoryMetric::HostProcessRssBytes,
    HistoryMetric::HostDiskUsedBytes,
];

impl HistoryMetric {
    fn unit(self) -> &'static str {
        match self {
            Self::TrafficTxRate | Self::TrafficRxRate => "bytes_per_second",
            Self::RpcErrorRate => "errors_per_second",
            Self::HostCpuPercent => "percent",
            _ => "bytes",
        }
    }

    fn host(self) -> bool {
        matches!(
            self,
            Self::HostCpuPercent
                | Self::HostMemoryUsedBytes
                | Self::HostProcessRssBytes
                | Self::HostDiskUsedBytes
        )
    }

    fn expression(self, scope: &MetricScope) -> String {
        let selector = scope.selector(!self.host());
        let network_group = "web_id,user_id,machine_id,network_id";
        let host_group = "web_id,user_id,machine_id";
        let expression = match self {
            Self::TrafficTxRate => {
                format!("sum by ({network_group}) (rate(traffic_bytes_tx{{{selector}}}[2m]))")
            }
            Self::TrafficRxRate => {
                format!("sum by ({network_group}) (rate(traffic_bytes_rx{{{selector}}}[2m]))")
            }
            Self::TrafficTxBytes => {
                format!("sum by ({network_group}) (traffic_bytes_tx{{{selector}}})")
            }
            Self::TrafficRxBytes => {
                format!("sum by ({network_group}) (traffic_bytes_rx{{{selector}}})")
            }
            Self::RpcErrorRate => {
                format!("sum by ({network_group}) (rate(peer_rpc_errors{{{selector}}}[2m]))")
            }
            metric => {
                // Resource gauges are duplicated by per-network scrape targets.
                // Deduplicate, and expire samples rather than displaying an old
                // successful reading after the underlying collector has failed.
                let (value, timestamp, freshness, group, component) = match metric {
                    Self::HostCpuPercent => (
                        format!("easytier_host_cpu_usage_percent{{{selector}}}"),
                        "easytier_host_resource_sample_timestamp_seconds",
                        30,
                        host_group,
                        "cpu",
                    ),
                    Self::HostMemoryUsedBytes => (
                        format!(
                            "easytier_host_memory_total_bytes{{{selector}}} - easytier_host_memory_available_bytes{{{selector}}}"
                        ),
                        "easytier_host_resource_sample_timestamp_seconds",
                        30,
                        host_group,
                        "memory",
                    ),
                    Self::HostProcessRssBytes => (
                        format!("easytier_host_process_rss_bytes{{{selector}}}"),
                        "easytier_host_resource_sample_timestamp_seconds",
                        30,
                        host_group,
                        "process_rss",
                    ),
                    Self::HostDiskUsedBytes => (
                        format!(
                            "easytier_host_disk_total_bytes{{{selector}}} - easytier_host_disk_available_bytes{{{selector}}}"
                        ),
                        "easytier_host_disk_sample_timestamp_seconds",
                        120,
                        "web_id,user_id,machine_id,mount_point",
                        "disks",
                    ),
                    _ => unreachable!(),
                };
                let healthy = format!("max by ({network_group}) (up{{{selector}}}) == 1");
                let recent = format!(
                    "(({timestamp}{{{selector}}} <= time() + 60) and (time() - {timestamp}{{{selector}}} < {freshness})) and on ({network_group}) ({healthy})"
                );
                let latest = format!(
                    "({recent}) == on ({host_group}) group_left() max by ({host_group}) ({recent})"
                );
                format!(
                    "max by ({group}) (({value}) and on ({network_group}) ({latest}) and on ({network_group}) (easytier_host_resource_collection_error{{{selector},component=\"{component}\"}} == 0))"
                )
            }
        };
        if self.host() {
            expression
        } else {
            format!(
                "({expression}) and on ({network_group}) (max by ({network_group}) (up{{{selector}}}) == 1)"
            )
        }
    }
}

struct MetricScope {
    web_id: String,
    user_id: UserIdInDb,
    machine_id: Uuid,
    network_id: Uuid,
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

impl MetricScope {
    fn labels(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("web_id".into(), self.web_id.clone()),
            ("user_id".into(), self.user_id.to_string()),
            ("machine_id".into(), self.machine_id.to_string()),
            ("network_id".into(), self.network_id.to_string()),
        ])
    }

    fn selector(&self, include_network: bool) -> String {
        self.labels()
            .into_iter()
            .filter(|(key, _)| include_network || key != "network_id")
            .map(|(key, value)| format!("{key}=\"{}\"", escape_label(&value)))
            .collect::<Vec<_>>()
            .join(",")
    }
}

#[derive(Serialize)]
struct MetricDescription {
    id: HistoryMetric,
    unit: &'static str,
}

#[derive(Serialize)]
struct Capabilities {
    history_available: bool,
    collector_enabled: bool,
    min_step_seconds: u64,
    max_range_seconds: u64,
    max_points_per_series: u64,
    max_series: usize,
    metrics: Vec<MetricDescription>,
}

async fn capabilities(
    auth: super::users::AuthSession,
    Extension(observability): Extension<Arc<Observability>>,
) -> Result<Json<Capabilities>, HttpHandleError> {
    let user_id = authed_user_id(&auth)?;
    Ok(Json(Capabilities {
        history_available: observability.history_url.is_some(),
        collector_enabled: observability
            .collector
            .as_ref()
            .is_some_and(|collector| collector.user_id == user_id),
        min_step_seconds: MIN_STEP,
        max_range_seconds: MAX_RANGE,
        max_points_per_series: MAX_POINTS,
        max_series: MAX_SERIES,
        metrics: METRICS
            .iter()
            .map(|&id| MetricDescription {
                id,
                unit: id.unit(),
            })
            .collect(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryQuery {
    metric: HistoryMetric,
    start: u64,
    end: u64,
    step: u64,
}

impl HistoryQuery {
    fn validate(&self, now: u64) -> Result<(), HttpHandleError> {
        if self.start >= self.end
            || self.end.saturating_sub(self.start) > MAX_RANGE
            || self.end > now.saturating_add(60)
            || self.step < MIN_STEP
            || self.step > MAX_RANGE
            || (self.end - self.start) / self.step + 1 > MAX_POINTS
        {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "invalid history range or step",
                "metrics_history_invalid_range",
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct HistorySeries {
    labels: BTreeMap<String, String>,
    values: Vec<(f64, Option<f64>)>,
}

#[derive(Serialize)]
struct HistoryResponse {
    available: bool,
    metric: HistoryMetric,
    unit: &'static str,
    start: u64,
    end: u64,
    step: u64,
    series: Vec<HistorySeries>,
}

fn api_error(status: StatusCode, message: &str, code: &str) -> HttpHandleError {
    let mut error = other_error(message);
    error.code = Some(code.to_owned());
    (status, Json(error))
}

async fn verify_history_owner(
    db: &Db,
    user_id: UserIdInDb,
    machine_id: Uuid,
    instance_id: Uuid,
) -> Result<(), HttpHandleError> {
    // Persisted ownership is deliberate: an offline device can still have
    // historical data. A deleted/migrated device or deleted instance cannot.
    let device = db
        .get_device((user_id, machine_id))
        .await
        .map_err(convert_db_error)?;
    let config = db
        .get_network_config((user_id, machine_id), &instance_id.to_string())
        .await
        .map_err(convert_db_error)?;
    if device.is_none() || config.is_none() {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "device network not found",
            "metrics_history_not_found",
        ));
    }
    Ok(())
}

async fn history(
    auth: super::users::AuthSession,
    Extension(observability): Extension<Arc<Observability>>,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Path((machine_id, instance_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryResponse>, HttpHandleError> {
    let user_id = authed_user_id(&auth)?;
    verify_history_owner(&service.db, user_id, machine_id, instance_id).await?;
    let scope = MetricScope {
        web_id: observability.web_id.clone(),
        user_id,
        machine_id,
        network_id: instance_id,
    };
    let response = query_history(&observability, &query, &scope).await?;
    // Fence a deletion or owner move while the storage query was in flight.
    verify_history_owner(&service.db, user_id, machine_id, instance_id).await?;
    Ok(Json(response))
}

async fn query_history(
    observability: &Observability,
    query: &HistoryQuery,
    scope: &MetricScope,
) -> Result<HistoryResponse, HttpHandleError> {
    let Some(base_url) = &observability.history_url else {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "metrics history is not configured",
            "metrics_history_disabled",
        ));
    };
    query.validate(chrono::Utc::now().timestamp().max(0) as u64)?;
    let _permit = observability.query_permits.try_acquire().map_err(|_| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "history query capacity reached",
            "metrics_history_busy",
        )
    })?;
    let mut url = base_url.clone();
    url.set_path(&format!(
        "{}/api/v1/query_range",
        base_url.path().trim_end_matches('/')
    ));
    url.query_pairs_mut().extend_pairs([
        ("query", query.metric.expression(scope)),
        ("start", query.start.to_string()),
        ("end", query.end.to_string()),
        ("step", query.step.to_string()),
    ]);
    let mut request = observability.client.get(url);
    if let Some(token) = &observability.history_token {
        request = request.bearer_auth(token);
    }
    // All HTTP errors use fixed messages. Reqwest error Debug/Display contains
    // the URL (and generated tenant query), so it must not be logged/returned.
    let body = tokio::time::timeout(QUERY_TIMEOUT, async {
        let mut response = request.send().await.map_err(storage_http_error)?;
        if !response.status().is_success() {
            return Err(api_error(
                StatusCode::BAD_GATEWAY,
                "history backend rejected the query",
                "metrics_history_backend_error",
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(invalid_history_response());
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(storage_http_error)? {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(invalid_history_response());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
    .await
    .map_err(|_| {
        api_error(
            StatusCode::GATEWAY_TIMEOUT,
            "history backend timed out",
            "metrics_history_timeout",
        )
    })??;
    let series = parse_matrix(&body, query, scope)?;
    Ok(HistoryResponse {
        available: true,
        metric: query.metric,
        unit: query.metric.unit(),
        start: query.start,
        end: query.end,
        step: query.step,
        series,
    })
}

fn storage_http_error(error: reqwest::Error) -> HttpHandleError {
    if error.is_timeout() {
        api_error(
            StatusCode::GATEWAY_TIMEOUT,
            "history backend timed out",
            "metrics_history_timeout",
        )
    } else {
        api_error(
            StatusCode::BAD_GATEWAY,
            "history backend is unavailable",
            "metrics_history_backend_error",
        )
    }
}

fn invalid_history_response() -> HttpHandleError {
    api_error(
        StatusCode::BAD_GATEWAY,
        "invalid or excessive history response",
        "metrics_history_invalid_response",
    )
}

#[derive(Deserialize)]
struct StorageResponse {
    status: String,
    data: Option<StorageData>,
}
#[derive(Deserialize)]
struct StorageData {
    #[serde(rename = "resultType")]
    result_type: String,
    result: Vec<StorageSeries>,
}
#[derive(Deserialize)]
struct StorageSeries {
    metric: BTreeMap<String, String>,
    values: Vec<(f64, String)>,
}

fn parse_matrix(
    body: &[u8],
    query: &HistoryQuery,
    scope: &MetricScope,
) -> Result<Vec<HistorySeries>, HttpHandleError> {
    let response: StorageResponse =
        serde_json::from_slice(body).map_err(|_| invalid_history_response())?;
    let data = response
        .data
        .filter(|data| response.status == "success" && data.result_type == "matrix")
        .ok_or_else(invalid_history_response)?;
    if data.result.len() > MAX_SERIES {
        return Err(invalid_history_response());
    }
    let expected = scope.labels();
    data.result
        .into_iter()
        .map(|series| {
            if series.metric.len() > 32
                || series
                    .metric
                    .iter()
                    .any(|(key, value)| key.len() > 128 || value.len() > 4096)
                || expected.iter().any(|(key, value)| {
                    (!query.metric.host() || key != "network_id")
                        && series.metric.get(key) != Some(value)
                })
                || series.values.len() > MAX_POINTS as usize
            {
                return Err(invalid_history_response());
            }
            let mut previous = None;
            let values = series
                .values
                .into_iter()
                .map(|(timestamp, value)| {
                    if !timestamp.is_finite()
                        || timestamp < query.start as f64
                        || timestamp > query.end as f64
                        || previous.is_some_and(|last| timestamp <= last)
                    {
                        return Err(invalid_history_response());
                    }
                    previous = Some(timestamp);
                    let value = value
                        .parse::<f64>()
                        .map_err(|_| invalid_history_response())?;
                    Ok((timestamp, value.is_finite().then_some(value)))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(HistorySeries {
                labels: series.metric,
                values,
            })
        })
        .collect()
}

pub(super) fn router() -> Router<super::AppStateInner> {
    Router::new()
        .route("/api/v1/observability/capabilities", get(capabilities))
        .route(
            "/api/v1/machines/{machine-id}/networks/{instance-id}/metrics/history",
            get(history),
        )
}

async fn collector_auth(
    Extension(observability): Extension<Arc<Observability>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if observability.collector_authorized(request.headers()) {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(other_error(
                "invalid or missing metrics collector credential",
            )),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct DiscoveryTarget {
    targets: Vec<String>,
    labels: BTreeMap<String, String>,
}

fn discovery_target(observability: &Observability, scope: &MetricScope) -> DiscoveryTarget {
    let collector = observability
        .collector
        .as_ref()
        .expect("collector router requires configuration");
    let mut labels = scope.labels();
    let mut url = collector.base_url.clone();
    url.set_path(&format!(
        "{}/api/metrics/users/{}/machines/{}/networks/{}/scrape",
        url.path().trim_end_matches('/'),
        scope.user_id,
        scope.machine_id,
        scope.network_id
    ));
    labels.insert("__scheme__".into(), url.scheme().into());
    labels.insert("__metrics_path__".into(), url.path().into());
    let host = match url.host().expect("validated base URL contains a host") {
        url::Host::Ipv6(ip) => format!("[{ip}]"),
        host => host.to_string(),
    };
    DiscoveryTarget {
        targets: vec![format!("{host}:{}", url.port_or_known_default().unwrap())],
        labels,
    }
}

async fn discovery(
    State(client_mgr): AppState,
    Extension(observability): Extension<Arc<Observability>>,
    Extension(service): Extension<Arc<CentralNetworkService>>,
) -> Result<Json<Vec<DiscoveryTarget>>, HttpHandleError> {
    let owner = observability.collector.as_ref().unwrap().user_id;
    let mut candidates = Vec::new();
    for token in client_mgr.list_sessions_by_user_id(owner).await {
        let Some(session) = client_mgr.get_session_by_machine_id(owner, &token.machine_id) else {
            continue;
        };
        if !session.management_access_valid().await {
            continue;
        }
        let Some(heartbeat) = session.get_heartbeat_req().await else {
            continue;
        };
        for instance in heartbeat.running_network_instances {
            let instance_id = Uuid::from(instance);
            if instance_id.is_nil() {
                continue;
            }
            candidates.push(MetricScope {
                web_id: observability.web_id.clone(),
                user_id: owner,
                machine_id: token.machine_id,
                network_id: instance_id,
            });
        }
    }
    Ok(Json(
        owned_discovery_targets(&observability, &service.db, candidates).await?,
    ))
}

async fn owned_discovery_targets(
    observability: &Observability,
    db: &Db,
    candidates: Vec<MetricScope>,
) -> Result<Vec<DiscoveryTarget>, HttpHandleError> {
    let mut targets = Vec::new();
    for scope in candidates {
        match verify_history_owner(db, scope.user_id, scope.machine_id, scope.network_id).await {
            Ok(()) => targets.push(discovery_target(observability, &scope)),
            Err((StatusCode::NOT_FOUND, _)) => continue,
            Err(error) => return Err(error),
        }
    }
    targets.sort_by(|a, b| a.labels.cmp(&b.labels));
    targets.dedup_by(|a, b| a.labels == b.labels);
    Ok(targets)
}

async fn verify_live_instance(session: &Session, instance_id: Uuid) -> Result<(), HttpHandleError> {
    if !session.management_access_valid().await {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "device management access is no longer authorized",
            "metrics_collector_forbidden",
        ));
    }
    if !session.get_heartbeat_req().await.is_some_and(|heartbeat| {
        heartbeat
            .running_network_instances
            .iter()
            .any(|id| Uuid::from(*id) == instance_id)
    }) {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "running device network not found",
            "metrics_collector_not_found",
        ));
    }
    Ok(())
}

async fn scrape(
    State(client_mgr): AppState,
    Extension(observability): Extension<Arc<Observability>>,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Path((owner, machine_id, instance_id)): Path<(UserIdInDb, Uuid, Uuid)>,
) -> Result<Response, HttpHandleError> {
    if observability
        .collector
        .as_ref()
        .is_none_or(|collector| collector.user_id != owner)
    {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "collector target not found",
            "metrics_collector_not_found",
        ));
    }
    verify_history_owner(&service.db, owner, machine_id, instance_id).await?;
    let session = client_mgr
        .get_session_by_machine_id(owner, &machine_id)
        .ok_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "device is offline",
                "metrics_collector_offline",
            )
        })?;
    verify_live_instance(&session, instance_id).await?;
    let response = tokio::time::timeout(
        Duration::from_secs(8),
        super::rpc::prometheus_stats_for_session(&session, instance_id),
    )
    .await
    .map_err(|_| {
        api_error(
            StatusCode::GATEWAY_TIMEOUT,
            "device metrics timed out",
            "metrics_collector_timeout",
        )
    })??;
    let body = to_bytes(response.into_body(), MAX_SCRAPE_BYTES)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::BAD_GATEWAY,
                "device metrics response is too large",
                "metrics_collector_invalid_response",
            )
        })?;
    let raw = std::str::from_utf8(&body).map_err(|_| {
        api_error(
            StatusCode::BAD_GATEWAY,
            "invalid device metrics response",
            "metrics_collector_invalid_response",
        )
    })?;
    let scope = MetricScope {
        web_id: observability.web_id.clone(),
        user_id: owner,
        machine_id,
        network_id: instance_id,
    };
    let text = scoped_prometheus(raw, &scope).map_err(|_| {
        api_error(
            StatusCode::BAD_GATEWAY,
            "invalid device metrics response",
            "metrics_collector_invalid_response",
        )
    })?;
    verify_live_instance(&session, instance_id).await?;
    verify_history_owner(&service.db, owner, machine_id, instance_id).await?;
    Ok((
        [(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        text,
    )
        .into_response())
}

pub(super) fn collector_router(
    client_mgr: Arc<ClientManager>,
    observability: Arc<Observability>,
    service: Arc<CentralNetworkService>,
) -> Router {
    if observability.collector.is_none() {
        return Router::new();
    }
    Router::new()
        .route("/api/metrics/discovery", get(discovery))
        .route(
            "/api/metrics/users/{user-id}/machines/{machine-id}/networks/{instance-id}/scrape",
            get(scrape),
        )
        .with_state(client_mgr)
        .route_layer(middleware::from_fn(collector_auth))
        .layer(Extension(observability))
        .layer(Extension(service))
}

fn valid_name(value: &str, metric: bool) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_' || (metric && c == b':'))
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_' || (metric && c == b':'))
}

fn parse_labels(value: &str) -> Result<BTreeMap<String, String>, ()> {
    let mut labels = BTreeMap::new();
    let mut rest = value.trim();
    while !rest.is_empty() {
        let equals = rest.find('=').ok_or(())?;
        let key = rest[..equals].trim();
        if !valid_name(key, false) || labels.len() >= 48 {
            return Err(());
        }
        rest = rest[equals + 1..]
            .trim_start()
            .strip_prefix('"')
            .ok_or(())?;
        let mut decoded = String::new();
        let mut escaped = false;
        let mut end = None;
        for (index, c) in rest.char_indices() {
            if escaped {
                decoded.push(match c {
                    '\\' => '\\',
                    '"' => '"',
                    'n' => '\n',
                    _ => return Err(()),
                });
                escaped = false;
            } else {
                match c {
                    '\\' => escaped = true,
                    '"' => {
                        end = Some(index);
                        break;
                    }
                    '\n' | '\r' => return Err(()),
                    _ => decoded.push(c),
                }
            }
        }
        if decoded.len() > 4096 || labels.insert(key.to_owned(), decoded).is_some() {
            return Err(());
        }
        rest = rest[end.ok_or(())? + 1..].trim_start();
        if !rest.is_empty() {
            rest = rest.strip_prefix(',').ok_or(())?.trim_start();
        }
    }
    Ok(labels)
}

fn scoped_prometheus(raw: &str, scope: &MetricScope) -> Result<String, ()> {
    if raw.len() > MAX_SCRAPE_BYTES {
        return Err(());
    }
    let mut output = String::with_capacity(raw.len());
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            output.push_str(line);
            output.push('\n');
            continue;
        }
        let end = line
            .find(|c: char| c == '{' || c.is_whitespace())
            .ok_or(())?;
        let name = &line[..end];
        if !valid_name(name, true) {
            return Err(());
        }
        let mut labels = BTreeMap::new();
        let tail = if line.as_bytes()[end] == b'{' {
            let mut quoted = false;
            let mut escaped = false;
            let mut closing = None;
            for (offset, c) in line[end + 1..].char_indices() {
                if escaped {
                    escaped = false;
                    continue;
                }
                if quoted && c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    quoted = !quoted;
                } else if !quoted && c == '}' {
                    closing = Some(end + 1 + offset);
                    break;
                }
            }
            let closing = closing.ok_or(())?;
            labels = parse_labels(&line[end + 1..closing])?;
            &line[closing + 1..]
        } else {
            &line[end..]
        };
        let values = tail.split_whitespace().collect::<Vec<_>>();
        if values.len() != 1 || values[0].parse::<f64>().is_err() {
            return Err(());
        }
        // A device cannot spoof a different tenant/installation. Strip any
        // supplied reserved label, then add the authenticated stable identity.
        labels.extend(scope.labels());
        let labels = labels
            .iter()
            .map(|(key, value)| format!("{key}=\"{}\"", escape_label(value)))
            .collect::<Vec<_>>()
            .join(",");
        output.push_str(&format!("{name}{{{labels}}} {}\n", values[0]));
        if output.len() > MAX_RESPONSE_BYTES {
            return Err(());
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::HeaderMap};
    use tower::ServiceExt as _;

    fn scope() -> MetricScope {
        MetricScope {
            web_id: "test-web".into(),
            user_id: 1,
            machine_id: Uuid::from_u128(1),
            network_id: Uuid::from_u128(2),
        }
    }

    fn history_options(url: &str) -> MetricsOptions {
        MetricsOptions {
            metrics_web_id: Some("test-web".into()),
            metrics_history_url: Some(url.into()),
            ..Default::default()
        }
    }

    fn collector_config() -> Observability {
        let mut config = Observability::from_options(MetricsOptions::default()).unwrap();
        config.web_id = "test-web".into();
        config.collector = Some(Collector {
            token_digest: digest("read-only-token"),
            user_id: 1,
            base_url: validated_base_url("http://[2001:db8::1]:11211/proxy/").unwrap(),
        });
        config
    }

    fn query() -> HistoryQuery {
        HistoryQuery {
            metric: HistoryMetric::TrafficTxRate,
            start: 100,
            end: 160,
            step: 15,
        }
    }

    fn matrix(labels: BTreeMap<String, String>, values: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "status":"success", "data":{"resultType":"matrix", "result":[{"metric":labels,"values":values}]}
        })).unwrap()
    }

    #[test]
    fn configuration_is_optional_and_secret_material_is_redacted() {
        let disabled = Observability::from_options(MetricsOptions::default()).unwrap();
        assert!(disabled.history_url.is_none());
        assert!(disabled.collector.is_none());
        let options = history_options("http://localhost:8428/private");
        assert!(!format!("{options:?}").contains("localhost"));
        assert!(
            !format!("{:?}", Observability::from_options(options).unwrap()).contains("private")
        );
        assert!(
            Observability::from_options(MetricsOptions {
                metrics_history_url: Some("http://localhost:8428".into()),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            Observability::from_options(MetricsOptions {
                metrics_collector_user_id: Some(1),
                ..Default::default()
            })
            .is_err()
        );
        for invalid in [
            "http://user:secret@host",
            "http://host?token=secret",
            "http://host#secret",
            "file:///etc/passwd",
        ] {
            assert!(validated_base_url(invalid).is_err());
        }
    }

    #[test]
    fn collector_bearer_is_separate_from_internal_and_device_credentials() {
        let config = collector_config();
        let mut headers = HeaderMap::new();
        headers.insert("X-Internal-Auth", "read-only-token".parse().unwrap());
        assert!(!config.collector_authorized(&headers));
        headers.insert(
            header::AUTHORIZATION,
            "Bearer device-token".parse().unwrap(),
        );
        assert!(!config.collector_authorized(&headers));
        headers.insert(
            header::AUTHORIZATION,
            "Bearer read-only-token".parse().unwrap(),
        );
        assert!(config.collector_authorized(&headers));
        assert!(!format!("{config:?}").contains("read-only-token"));
    }

    #[tokio::test]
    async fn read_only_router_rejects_other_owners_and_contains_no_mutation_routes() {
        let db = Db::memory_db().await;
        let manager = Arc::new(ClientManager::new(
            db.clone(),
            None,
            Default::default(),
            Arc::new(crate::FeatureFlags::default()),
            Arc::new(crate::webhook::WebhookConfig::new(
                None, None, None, None, None,
            )),
        ));
        let service = Arc::new(CentralNetworkService::new(db, manager.clone()));
        let router = collector_router(manager, Arc::new(collector_config()), service);
        let path = format!(
            "/api/metrics/users/2/machines/{}/networks/{}/scrape",
            scope().machine_id,
            scope().network_id
        );
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(header::AUTHORIZATION, "Bearer read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/metrics/discovery")
                    .header("X-Internal-Auth", "read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/metrics/discovery")
                    .header(header::AUTHORIZATION, "Bearer read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/internal/sessions")
                    .header(header::AUTHORIZATION, "Bearer read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn collector_requires_persisted_instance_and_drops_deleted_targets() {
        let db = Db::memory_db().await;
        let owner = db
            .auto_create_user("collector-persistent-owner")
            .await
            .unwrap()
            .id;
        let candidate = MetricScope {
            user_id: owner,
            ..scope()
        };
        db.upsert_device_heartbeat(crate::db::DeviceHeartbeatRecord {
            user_id: owner,
            machine_id: candidate.machine_id,
            hostname: "cli-network-device".into(),
            easytier_version: "2.7".into(),
            device_os: "{}".into(),
            client_url: "udp://127.0.0.1:1".into(),
        })
        .await
        .unwrap();
        let mut config = collector_config();
        config.collector.as_mut().unwrap().user_id = owner;
        let config = Arc::new(config);
        let manager = Arc::new(ClientManager::new(
            db.clone(),
            None,
            Default::default(),
            Arc::new(crate::FeatureFlags::default()),
            Arc::new(crate::webhook::WebhookConfig::new(
                None, None, None, None, None,
            )),
        ));
        let service = Arc::new(CentralNetworkService::new(db.clone(), manager.clone()));
        let router = collector_router(manager, config.clone(), service);
        let request = || {
            Request::builder()
                .uri(format!(
                    "/api/metrics/users/{owner}/machines/{}/networks/{}/scrape",
                    candidate.machine_id, candidate.network_id
                ))
                .header(header::AUTHORIZATION, "Bearer read-only-token")
                .body(Body::empty())
                .unwrap()
        };

        // A live heartbeat candidate alone does not grant historical ownership.
        let targets = owned_discovery_targets(
            &config,
            &db,
            vec![MetricScope {
                user_id: owner,
                ..scope()
            }],
        )
        .await
        .unwrap();
        assert!(targets.is_empty());
        let response = router.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(response["code"], "metrics_history_not_found");

        db.insert_or_update_user_network_config(
            (owner, candidate.machine_id),
            candidate.network_id,
            easytier::common::config::NetworkConfig {
                instance_id: Some(candidate.network_id.to_string()),
                ..Default::default()
            },
            easytier::common::config::ConfigSource::Web,
        )
        .await
        .unwrap();
        let targets = owned_discovery_targets(
            &config,
            &db,
            vec![MetricScope {
                user_id: owner,
                ..scope()
            }],
        )
        .await
        .unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(
            targets[0].labels["network_id"],
            candidate.network_id.to_string()
        );
        let response = router.clone().oneshot(request()).await.unwrap();
        let response: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(
            response["code"], "metrics_collector_offline",
            "persisted ownership must pass before live-session verification"
        );

        // An old heartbeat cannot revive a deleted persisted instance.
        db.delete_network_configs((owner, candidate.machine_id), &[candidate.network_id])
            .await
            .unwrap();
        assert!(
            owned_discovery_targets(
                &config,
                &db,
                vec![MetricScope {
                    user_id: owner,
                    ..scope()
                }]
            )
            .await
            .unwrap()
            .is_empty()
        );
        let response = router.oneshot(request()).await.unwrap();
        let response: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(response["code"], "metrics_history_not_found");
    }

    #[test]
    fn discovery_uses_only_the_explicit_destination_and_scoped_path() {
        let target = discovery_target(&collector_config(), &scope());
        assert_eq!(target.targets, ["[2001:db8::1]:11211"]);
        assert_eq!(target.labels["__scheme__"], "http");
        assert_eq!(target.labels["user_id"], "1");
        assert_eq!(
            target.labels["__metrics_path__"],
            format!(
                "/proxy/api/metrics/users/1/machines/{}/networks/{}/scrape",
                scope().machine_id,
                scope().network_id
            )
        );
    }

    #[test]
    fn exporter_overrides_spoofed_tenant_labels_and_escapes_values() {
        let raw = "# TYPE traffic_bytes_tx counter\ntraffic_bytes_tx{user_id=\"999\",machine_id=\"spoof\",network_name=\"quote\\\"\\nslash\\\\\"} 7\ntraffic_bytes_rx 0\n";
        let exported = scoped_prometheus(raw, &scope()).unwrap();
        assert!(!exported.contains("999"));
        assert!(!exported.contains("spoof"));
        assert!(exported.contains("user_id=\"1\""));
        assert!(exported.contains("network_id=\"00000000-0000-0000-0000-000000000002\""));
        assert!(exported.contains("network_name=\"quote\\\"\\nslash\\\\\""));
        assert!(exported.contains("} 0\n"));
        for invalid in [
            "bad metric 1",
            "m{x=\"1\",x=\"2\"} 1",
            "m{x=\"unterminated} 1",
            "m 1 123",
            "m{x=\"bad\\q\"} 1",
            "m 1\nweb_id=oops",
        ] {
            assert!(scoped_prometheus(invalid, &scope()).is_err(), "{invalid}");
        }
    }

    #[test]
    fn fixed_query_templates_scope_every_metric_and_deduplicate_host_resources() {
        for metric in METRICS {
            let expression = metric.expression(&scope());
            for name in [
                "web_id=\"test-web\"",
                "user_id=\"1\"",
                "machine_id=\"00000000-0000-0000-0000-000000000001\"",
            ] {
                assert!(expression.contains(name), "{expression}");
            }
            if metric.host() {
                assert!(expression.starts_with("max by"));
                assert!(!expression.contains("network_id=\""));
                assert!(expression.contains("sample_timestamp_seconds"));
                assert!(expression.contains("collection_error"));
                assert!(expression.contains("<= time() + 60"));
                assert!(expression.contains("== on (web_id,user_id,machine_id) group_left()"));
            } else {
                assert!(expression.contains("network_id=\"00000000-0000-0000-0000-000000000002\""));
            }
        }
        assert!(
            HistoryMetric::HostDiskUsedBytes
                .expression(&scope())
                .contains("component=\"disks\"")
        );
        assert_eq!(escape_label("a\"\\\nb"), "a\\\"\\\\\\nb");
        assert!(
            serde_json::from_value::<HistoryQuery>(
                serde_json::json!({"metric":"up{user_id=\"2\"}","start":100,"end":200,"step":15})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<HistoryQuery>(serde_json::json!({"metric":"traffic_tx_rate","query":"up","start":100,"end":200,"step":15})).is_err());
    }

    #[test]
    fn range_and_response_boundaries_preserve_gaps_and_reject_foreign_labels() {
        assert!(query().validate(200).is_ok());
        for invalid in [
            HistoryQuery {
                start: 160,
                ..query()
            },
            HistoryQuery { step: 0, ..query() },
            HistoryQuery { step: 1, ..query() },
            HistoryQuery {
                end: MAX_RANGE + 101,
                ..query()
            },
            HistoryQuery {
                end: 100_000,
                ..query()
            },
            HistoryQuery {
                end: 300,
                ..query()
            },
        ] {
            assert!(invalid.validate(200).is_err());
        }
        let body = matrix(
            scope().labels(),
            serde_json::json!([[100, "1"], [130, "NaN"], [160, "+Inf"]]),
        );
        let values = &parse_matrix(&body, &query(), &scope()).unwrap()[0].values;
        assert_eq!(values, &[(100., Some(1.)), (130., None), (160., None)]);
        let mut foreign = scope().labels();
        foreign.insert("user_id".into(), "2".into());
        assert!(
            parse_matrix(
                &matrix(foreign, serde_json::json!([[100, "1"]])),
                &query(),
                &scope()
            )
            .is_err()
        );
        for samples in [
            serde_json::json!([[100, "1"], [100, "2"]]),
            serde_json::json!([[99, "1"]]),
            serde_json::json!([[161, "1"]]),
            serde_json::json!([[100, "not-a-number"]]),
        ] {
            assert!(parse_matrix(&matrix(scope().labels(), samples), &query(), &scope()).is_err());
        }
        let empty = br#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#;
        assert!(parse_matrix(empty, &query(), &scope()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn history_requires_persisted_owner_and_survives_offline_then_denies_deletion() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("owner-history").await.unwrap().id;
        let other = db.auto_create_user("other-history").await.unwrap().id;
        let scope = scope();
        db.upsert_device_heartbeat(crate::db::DeviceHeartbeatRecord {
            user_id: owner,
            machine_id: scope.machine_id,
            hostname: "offline-host".into(),
            easytier_version: "2.7".into(),
            device_os: "{}".into(),
            client_url: "udp://127.0.0.1:1".into(),
        })
        .await
        .unwrap();
        let config = easytier::common::config::NetworkConfig {
            instance_id: Some(scope.network_id.to_string()),
            ..Default::default()
        };
        db.insert_or_update_user_network_config(
            (owner, scope.machine_id),
            scope.network_id,
            config,
            easytier::common::config::ConfigSource::Web,
        )
        .await
        .unwrap();
        verify_history_owner(&db, owner, scope.machine_id, scope.network_id)
            .await
            .unwrap();
        assert_eq!(
            verify_history_owner(&db, other, scope.machine_id, scope.network_id)
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
        db.delete_network_configs((owner, scope.machine_id), &[scope.network_id])
            .await
            .unwrap();
        assert_eq!(
            verify_history_owner(&db, owner, scope.machine_id, scope.network_id)
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn history_disabled_does_not_contact_storage_or_return_zero() {
        let disabled = Observability::from_options(MetricsOptions::default()).unwrap();
        let error = query_history(&disabled, &query(), &scope())
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.1.0.code.as_deref(), Some("metrics_history_disabled"));
    }

    #[tokio::test]
    async fn history_http_timeout_is_bounded_and_secret_errors_are_not_exposed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let mut config =
            Observability::from_options(history_options(&format!("http://{addr}/private-storage")))
                .unwrap();
        config.history_token = Some("do-not-expose".into());
        config.client = reqwest::Client::builder()
            .timeout(Duration::from_millis(50))
            .no_proxy()
            .build()
            .unwrap();
        let error = query_history(&config, &query(), &scope())
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, StatusCode::GATEWAY_TIMEOUT);
        let public_error = serde_json::to_string(&error.1.0).unwrap();
        assert!(!public_error.contains("private-storage"));
        assert!(!public_error.contains("do-not-expose"));
        assert!(!public_error.contains("127.0.0.1"));
        task.abort();
    }

    /// Explicit external-engine contract test. These are synthetic samples,
    /// separate from the native Core/collector end-to-end acceptance test.
    #[tokio::test]
    #[ignore = "requires ET_VM_TEST_BIN and permission to bind a local test port"]
    async fn synthetic_victoriametrics_templates_choose_latest_and_leave_failure_gaps() {
        struct TestVm {
            child: std::process::Child,
            directory: PathBuf,
        }
        impl Drop for TestVm {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = std::fs::remove_dir_all(&self.directory);
            }
        }
        let binary = std::env::var("ET_VM_TEST_BIN")
            .expect("set ET_VM_TEST_BIN for the explicit VictoriaMetrics contract test");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let directory =
            std::env::temp_dir().join(format!("easytier-vm-contract-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let child = std::process::Command::new(binary)
            .arg(format!("-httpListenAddr={address}"))
            .arg(format!("-storageDataPath={}", directory.display()))
            .arg("-retentionPeriod=1d")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let _vm = TestVm { child, directory };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .unwrap();
        let base = format!("http://{address}");
        let mut ready = false;
        for _ in 0..100 {
            if client
                .get(format!("{base}/health"))
                .send()
                .await
                .is_ok_and(|response| response.status().is_success())
            {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(ready, "isolated synthetic VictoriaMetrics did not start");
        let config = Observability::from_options(history_options(&base)).unwrap();
        let timestamp = chrono::Utc::now().timestamp() as u64 - 45;
        let owner_scope = scope();
        let second_scope = MetricScope {
            network_id: Uuid::from_u128(3),
            ..scope()
        };
        let future_scope = MetricScope {
            network_id: Uuid::from_u128(4),
            ..scope()
        };
        let foreign_scope = MetricScope {
            user_id: 2,
            ..scope()
        };
        let sample = |name: &str, scope: &MetricScope, extra: &str, value: f64, at: u64| {
            let extra = if extra.is_empty() {
                String::new()
            } else {
                format!(",{extra}")
            };
            format!(
                "{name}{{{}{extra}}} {value} {}\n",
                scope.selector(true),
                at * 1000
            )
        };
        let mut input = String::new();
        for (target, cpu, sampled_at, used_disk) in [
            (&owner_scope, 80., timestamp - 20, 900.),
            (&second_scope, 10., timestamp - 5, 200.),
            (&future_scope, 99., timestamp + 3600, 999.),
            (&foreign_scope, 100., timestamp - 1, 999.),
        ] {
            input += &sample("up", target, "", 1., timestamp);
            input += &sample(
                "easytier_host_cpu_usage_percent",
                target,
                "",
                cpu,
                timestamp,
            );
            input += &sample(
                "easytier_host_resource_sample_timestamp_seconds",
                target,
                "",
                sampled_at as f64,
                timestamp,
            );
            input += &sample(
                "easytier_host_disk_sample_timestamp_seconds",
                target,
                "",
                sampled_at as f64,
                timestamp,
            );
            input += &sample(
                "easytier_host_resource_collection_error",
                target,
                "component=\"cpu\"",
                0.,
                timestamp,
            );
            input += &sample(
                "easytier_host_resource_collection_error",
                target,
                "component=\"disks\"",
                0.,
                timestamp,
            );
            input += &sample(
                "easytier_host_disk_total_bytes",
                target,
                "mount_point=\"/data\"",
                1000.,
                timestamp,
            );
            input += &sample(
                "easytier_host_disk_available_bytes",
                target,
                "mount_point=\"/data\"",
                1000. - used_disk,
                timestamp,
            );
        }
        for (index, offset) in [45, 30, 15, 0].into_iter().enumerate() {
            input += &sample(
                "traffic_bytes_tx",
                &owner_scope,
                "",
                (index * 1500) as f64,
                timestamp - offset,
            );
        }
        let response = client
            .post(format!("{base}/api/v1/import/prometheus"))
            .body(input)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        // VictoriaMetrics acknowledges buffered imports before their data is
        // searchable. Establish a real write visibility barrier for this
        // synthetic fixture; never call this endpoint from the Web API.
        assert!(
            client
                .get(format!("{base}/internal/force_flush"))
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
        // Import is asynchronous: wait for the independently queried engine
        // to expose a real result, without accepting an empty result as a pass.
        let cpu_query = HistoryQuery {
            metric: HistoryMetric::HostCpuPercent,
            start: timestamp,
            end: timestamp + 15,
            step: 15,
        };
        let mut cpu = None;
        for _ in 0..50 {
            let result = query_history(&config, &cpu_query, &owner_scope)
                .await
                .unwrap();
            if !result.series.is_empty() {
                cpu = Some(result);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let cpu = cpu.expect("latest valid CPU result must be present");
        assert_eq!(cpu.series.len(), 1);
        assert!(
            cpu.series[0]
                .values
                .iter()
                .all(|(_, value)| *value == Some(10.)),
            "older high CPU, future timestamp and another owner's CPU must not win"
        );
        let disk_query = HistoryQuery {
            metric: HistoryMetric::HostDiskUsedBytes,
            ..cpu_query
        };
        let disk = query_history(&config, &disk_query, &owner_scope)
            .await
            .unwrap();
        assert_eq!(disk.series.len(), 1);
        assert_eq!(
            disk.series[0].labels.get("mount_point").map(String::as_str),
            Some("/data")
        );
        assert!(
            disk.series[0]
                .values
                .iter()
                .all(|(_, value)| *value == Some(200.))
        );
        let rate_query = HistoryQuery {
            metric: HistoryMetric::TrafficTxRate,
            ..cpu_query
        };
        let rate = query_history(&config, &rate_query, &owner_scope)
            .await
            .unwrap();
        assert!(!rate.series.is_empty());
        assert!(
            rate.series[0]
                .values
                .iter()
                .any(|(_, value)| value.is_some_and(|rate| rate > 0.))
        );

        let failure_time = timestamp + 15;
        let failed = sample(
            "easytier_host_resource_collection_error",
            &second_scope,
            "component=\"disks\"",
            1.,
            failure_time,
        ) + &sample("up", &owner_scope, "", 0., failure_time);
        assert!(
            client
                .post(format!("{base}/api/v1/import/prometheus"))
                .body(failed)
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
        assert!(
            client
                .get(format!("{base}/internal/force_flush"))
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
        let failed_disk = HistoryQuery {
            start: failure_time,
            end: failure_time + 15,
            ..disk_query
        };
        let failed_rate = HistoryQuery {
            start: failure_time,
            end: failure_time + 15,
            ..rate_query
        };
        let mut confirmed_gap = false;
        for _ in 0..50 {
            let disk = query_history(&config, &failed_disk, &owner_scope)
                .await
                .unwrap();
            let rate = query_history(&config, &failed_rate, &owner_scope)
                .await
                .unwrap();
            if disk.series.is_empty() && rate.series.is_empty() {
                confirmed_gap = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            confirmed_gap,
            "failed disk reads and offline targets must create gaps, not zeros or stale positive rates"
        );
    }
}
