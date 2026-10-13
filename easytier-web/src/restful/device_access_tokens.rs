use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use uuid::Uuid;

use super::{
    AppStateInner, ConsoleInfoConfig, HttpHandleError, authed_user_id, convert_db_error,
    other_error, users::AuthSession,
};
use crate::central_network::service::CentralNetworkService;
use crate::db::{DeviceAccessTokenInfo, IssuedDeviceAccessToken};
use std::sync::Arc;

#[derive(serde::Deserialize)]
struct CreateRequest {
    label: String,
    machine_id: Option<Uuid>,
    expires_in_seconds: Option<u64>,
}

#[derive(serde::Serialize)]
struct ListResponse {
    tokens: Vec<DeviceAccessTokenInfo>,
}

fn local_only(config: &ConsoleInfoConfig) -> Result<(), HttpHandleError> {
    if config.webhook_auth {
        return Err((
            StatusCode::CONFLICT,
            Json(other_error(
                "External webhook mode manages device credentials through its own controller",
            )),
        ));
    }
    Ok(())
}

async fn list(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
) -> Result<Json<ListResponse>, HttpHandleError> {
    local_only(&config)?;
    let tokens = service
        .db
        .list_device_access_tokens(authed_user_id(&auth)?)
        .await
        .map_err(convert_db_error)?;
    Ok(Json(ListResponse { tokens }))
}

async fn create(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
    Json(req): Json<CreateRequest>,
) -> Result<Json<IssuedDeviceAccessToken>, HttpHandleError> {
    local_only(&config)?;
    // Validate user input separately from database errors, without returning secret material.
    if req.label.trim().is_empty()
        || req.label.trim().chars().count() > 128
        || req
            .expires_in_seconds
            .is_some_and(|seconds| seconds == 0 || seconds > 10 * 365 * 24 * 3600)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(other_error("Invalid label or token lifetime")),
        ));
    }
    let owner = authed_user_id(&auth)?;
    if let Some(machine_id) = req.machine_id {
        if service
            .db
            .is_device_blocked((owner, machine_id))
            .await
            .map_err(convert_db_error)?
        {
            return Err((StatusCode::CONFLICT, Json(other_error("Device is blocked"))));
        }
        if service
            .db
            .device_has_active_access_token(owner, machine_id)
            .await
            .map_err(convert_db_error)?
        {
            return Err((
                StatusCode::CONFLICT,
                Json(other_error(
                    "Device already has an active access token; rotate it instead",
                )),
            ));
        }
    }
    service
        .db
        .create_device_access_token(owner, &req.label, req.machine_id, req.expires_in_seconds)
        .await
        .map(Json)
        .map_err(|error| {
            if matches!(&error,sea_orm::DbErr::Custom(message) if message.starts_with("device already") || message=="device is blocked") {
                (StatusCode::CONFLICT,Json(other_error(error)))
            } else { convert_db_error(error) }
        })
}

async fn rotate(
    auth: AuthSession,
    State(manager): State<AppStateInner>,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
    Path(id): Path<Uuid>,
) -> Result<Json<IssuedDeviceAccessToken>, HttpHandleError> {
    local_only(&config)?;
    let owner = authed_user_id(&auth)?;
    let id = id.to_string();
    if service
        .db
        .get_device_access_token(owner, &id)
        .await
        .map_err(convert_db_error)?
        .is_none()
    {
        return Err((
            StatusCode::NOT_FOUND,
            Json(other_error("Device access token not found")),
        ));
    }
    let issued = service
        .db
        .rotate_device_access_token(owner, &id)
        .await
        .map_err(convert_db_error)?
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(other_error(
                    "Expired or revoked tokens cannot be rotated; create a new token",
                )),
            )
        })?;
    manager
        .disconnect_sessions_by_device_token(owner, &id, issued.info.auth_generation)
        .await;
    if let Some(hash) = issued.retired_token_hash.as_deref() {
        manager.disconnect_sessions_by_device_token_hash(hash).await;
    }
    Ok(Json(issued))
}

async fn revoke(
    auth: AuthSession,
    State(manager): State<AppStateInner>,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(config): Extension<ConsoleInfoConfig>,
    Path(id): Path<Uuid>,
) -> Result<Json<DeviceAccessTokenInfo>, HttpHandleError> {
    local_only(&config)?;
    let owner = authed_user_id(&auth)?;
    let id = id.to_string();
    let info = service
        .db
        .revoke_device_access_token(owner, &id)
        .await
        .map_err(convert_db_error)?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(other_error("Device access token not found")),
            )
        })?;
    manager
        .disconnect_sessions_by_device_token(owner, &id, info.auth_generation)
        .await;
    service
        .db
        .delete_revoked_device_access_token(owner, &id)
        .await
        .map_err(convert_db_error)?;
    Ok(Json(info))
}

pub(super) fn router() -> Router<AppStateInner> {
    Router::new()
        .route("/api/v1/device-access-tokens", get(list).post(create))
        .route("/api/v1/device-access-tokens/{id}/rotate", post(rotate))
        .route("/api/v1/device-access-tokens/{id}", delete(revoke))
}
