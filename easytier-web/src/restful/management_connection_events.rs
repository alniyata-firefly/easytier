use std::sync::Arc;

use axum::{Extension, Json, Router, extract::Query, http::StatusCode, routing::get};
use uuid::Uuid;

use super::{
    AppStateInner, HttpHandleError, authed_user_id, convert_db_error, other_error,
    users::AuthSession,
};
use crate::{central_network::service::CentralNetworkService, db::ManagementConnectionEventPage};

#[derive(Default, serde::Deserialize)]
struct ListQuery {
    device_id: Option<Uuid>,
    before_id: Option<i64>,
    limit: Option<u32>,
}

async fn list(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ManagementConnectionEventPage>, HttpHandleError> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=200).contains(&limit) || query.before_id.is_some_and(|id| id <= 0) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(other_error("invalid event pagination")),
        ));
    }
    service
        .db
        .list_management_connection_events(
            authed_user_id(&auth)?,
            query.device_id,
            query.before_id,
            limit,
        )
        .await
        .map(Json)
        .map_err(convert_db_error)
}

pub(super) fn router() -> Router<AppStateInner> {
    Router::new().route("/api/v1/management-connection-events", get(list))
}
