use std::sync::Arc;

use axum::{
    Extension, Json, Router,
    extract::Path,
    http::StatusCode,
    routing::{get, post},
};
use uuid::Uuid;

use super::{
    AppStateInner, ConsoleInfoConfig, HttpHandleError, authed_user_id, convert_db_error,
    other_error, users::AuthSession,
};
use crate::{
    central_network::service::CentralNetworkService,
    db::{DeviceRebindApproval, DeviceRebindError, DeviceRebindRequestInfo},
};

#[derive(serde::Serialize)]
struct ListResponse {
    requests: Vec<DeviceRebindRequestInfo>,
}

fn local_only(config: &ConsoleInfoConfig) -> Result<(), HttpHandleError> {
    if config.webhook_auth {
        return Err((
            StatusCode::CONFLICT,
            Json(other_error(
                "External webhook mode manages device identity through its own controller",
            )),
        ));
    }
    Ok(())
}

fn recovery_error(error: DeviceRebindError) -> HttpHandleError {
    match error {
        DeviceRebindError::NotFound => (StatusCode::NOT_FOUND, Json(other_error(error))),
        DeviceRebindError::Conflict(_) => (StatusCode::CONFLICT, Json(other_error(error))),
        DeviceRebindError::Database(error) => convert_db_error(error),
    }
}

async fn list(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
) -> Result<Json<ListResponse>, HttpHandleError> {
    local_only(&config)?;
    Ok(Json(ListResponse {
        requests: service
            .db
            .list_device_rebind_requests(authed_user_id(&auth)?)
            .await
            .map_err(convert_db_error)?,
    }))
}

async fn approve(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeviceRebindApproval>, HttpHandleError> {
    local_only(&config)?;
    service
        .approve_device_rebind(authed_user_id(&auth)?, id)
        .await
        .map(Json)
        .map_err(recovery_error)
}

async fn reject(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, HttpHandleError> {
    local_only(&config)?;
    service
        .db
        .reject_device_rebind_request(authed_user_id(&auth)?, id)
        .await
        .map_err(recovery_error)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) fn router() -> Router<AppStateInner> {
    Router::new()
        .route("/api/v1/device-rebind-requests", get(list))
        .route("/api/v1/device-rebind-requests/{id}/approve", post(approve))
        .route("/api/v1/device-rebind-requests/{id}/reject", post(reject))
}
