//! Resources of the Web process and its server, independent of managed Cores.

use std::sync::Arc;

use axum::{Extension, Json, Router, http::StatusCode, routing::get};
use easytier::{
    instance::host_resources,
    proto::api::instance::{HostDiskResources, HostResources},
};
use easytier_core::instance::host_resources::HostResourcesSnapshot;
use serde::Serialize;

use crate::{
    central_network::service::CentralNetworkService,
    db::{Db, UserIdInDb},
};

use super::{
    AppStateInner, HttpHandleError, authed_user_id, convert_db_error, other_error,
    users::AuthSession,
};

#[derive(Serialize)]
struct ServerResourcesResponse {
    host_resources_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_resources: Option<HostResources>,
}

async fn ensure_admin(db: &Db, user_id: UserIdInDb) -> Result<(), HttpHandleError> {
    // Current SeaORM migrations seed the `admins` group. The obsolete SQL
    // fixture's `superusers` name is not the live schema. Scope this join to
    // the authenticated user; Backend::get_group_permissions currently lacks
    // that filter and must not authorize global host observations.
    let is_admin: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users_groups ug JOIN groups g ON g.id=ug.group_id WHERE ug.user_id=? AND g.name='admins')",
    )
    .bind(user_id)
    .fetch_one(&db.inner())
    .await
    .map_err(|error| convert_db_error(sea_orm::DbErr::Custom(error.to_string())))?;
    if !is_admin {
        let mut error = other_error("server resource observations require administrator access");
        error.code = Some("server_resources_forbidden".to_owned());
        return Err((StatusCode::FORBIDDEN, Json(error)));
    }
    Ok(())
}

fn resource_message(snapshot: HostResourcesSnapshot) -> HostResources {
    HostResources {
        sampled_at_unix_ms: snapshot.sampled_at_unix_ms,
        cpu_usage_percent: snapshot.cpu_usage_percent,
        memory_total_bytes: snapshot.memory_total_bytes,
        memory_available_bytes: snapshot.memory_available_bytes,
        process_rss_bytes: snapshot.process_rss_bytes,
        disks: snapshot
            .disks
            .into_iter()
            .map(|disk| HostDiskResources {
                mount_point: disk.mount_point,
                total_bytes: disk.total_bytes,
                available_bytes: disk.available_bytes,
            })
            .collect(),
        disks_sampled_at_unix_ms: snapshot.disks_sampled_at_unix_ms,
        collection_errors: snapshot.collection_errors,
    }
}

async fn resources(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
) -> Result<Json<ServerResourcesResponse>, HttpHandleError> {
    let user_id = authed_user_id(&auth)?;
    ensure_admin(&service.db, user_id).await?;
    let snapshot = host_resources::snapshot().await;
    // Role removal while filesystem sampling was in flight must not release
    // observations to a session that no longer has administrative access.
    ensure_admin(&service.db, user_id).await?;
    Ok(Json(ServerResourcesResponse {
        host_resources_supported: host_resources::supported(),
        host_resources: snapshot.map(resource_message),
    }))
}

pub(super) fn router() -> Router<AppStateInner> {
    Router::new().route("/api/v1/server/resources", get(resources))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, header},
    };
    use axum_login::{AuthManagerLayerBuilder, login_required};
    use easytier_core::instance::host_resources::HostDiskResourcesSnapshot;
    use tower::ServiceExt as _;

    use crate::{
        client_manager::ClientManager,
        restful::{auth, users::Backend},
    };

    async fn add_admin_group(db: &Db, user_id: UserIdInDb) {
        assert_eq!(sqlx::query("INSERT INTO users_groups(user_id,group_id) SELECT ?,id FROM groups WHERE name='admins'")
            .bind(user_id).execute(&db.inner()).await.unwrap().rows_affected(), 1);
    }

    async fn remove_admin_group(db: &Db, user_id: UserIdInDb) {
        assert_eq!(sqlx::query("DELETE FROM users_groups WHERE user_id=? AND group_id IN (SELECT id FROM groups WHERE name='admins')")
            .bind(user_id).execute(&db.inner()).await.unwrap().rows_affected(), 1);
    }

    #[tokio::test]
    async fn authorization_uses_actual_scoped_group_and_changes_immediately() {
        let db = Db::memory_db().await;
        let seeded = db.get_user_id("admin").await.unwrap().unwrap();
        ensure_admin(&db, seeded).await.unwrap();
        // Renaming an administrator does not remove the role. Reusing the old
        // username for an ordinary account does not confer that role.
        sqlx::query("UPDATE users SET username='renamed-administrator' WHERE id=?")
            .bind(seeded)
            .execute(&db.inner())
            .await
            .unwrap();
        let ordinary_admin_name = db.auto_create_user("admin").await.unwrap().id;
        assert_eq!(
            ensure_admin(&db, ordinary_admin_name).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        ensure_admin(&db, seeded).await.unwrap();
        let delegated = db
            .auto_create_user("delegated-server-operator")
            .await
            .unwrap()
            .id;
        assert_eq!(
            ensure_admin(&db, delegated).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        add_admin_group(&db, delegated).await;
        ensure_admin(&db, delegated).await.unwrap();
        remove_admin_group(&db, delegated).await;
        assert_eq!(
            ensure_admin(&db, delegated).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn server_json_preserves_protobuf_u64_strings_and_missing_observations() {
        let snapshot = HostResourcesSnapshot {
            sampled_at_unix_ms: u64::MAX,
            cpu_usage_percent: None,
            memory_total_bytes: Some(u64::MAX),
            memory_available_bytes: Some(0),
            process_rss_bytes: Some(u64::MAX - 1),
            disks: vec![HostDiskResourcesSnapshot {
                mount_point: "/data".into(),
                total_bytes: u64::MAX,
                available_bytes: 1,
            }],
            disks_sampled_at_unix_ms: Some(u64::MAX - 2),
            collection_errors: vec!["cpu".into()],
        };
        let response = serde_json::to_value(ServerResourcesResponse {
            host_resources_supported: true,
            host_resources: Some(resource_message(snapshot)),
        })
        .unwrap();
        assert_eq!(
            response["host_resources"]["memory_total_bytes"],
            u64::MAX.to_string()
        );
        assert_eq!(response["host_resources"]["memory_available_bytes"], "0");
        assert_eq!(
            response["host_resources"]["process_rss_bytes"],
            (u64::MAX - 1).to_string()
        );
        assert_eq!(
            response["host_resources"]["disks"][0]["total_bytes"],
            u64::MAX.to_string()
        );
        assert_eq!(
            response["host_resources"]["disks"][0]["available_bytes"],
            "1"
        );
        assert!(
            response["host_resources"]
                .get("cpu_usage_percent")
                .is_none()
        );
        assert_eq!(
            response["host_resources"]["collection_errors"],
            serde_json::json!(["cpu"])
        );
        let unsupported = serde_json::to_value(ServerResourcesResponse {
            host_resources_supported: false,
            host_resources: None,
        })
        .unwrap();
        assert_eq!(unsupported["host_resources_supported"], false);
        assert!(unsupported.get("host_resources").is_none());
    }

    async fn login(app: &Router, username: &str, password: &str) -> String {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(
                            &serde_json::json!({"username":username,"password":password}),
                        )
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn actual_server_resources_require_admin_session_without_any_managed_core() {
        let db = Db::memory_db().await;
        let password = "server-resources-test-password";
        let admin = db
            .create_user_and_join_users_group(
                "server-resource-admin",
                password_auth::generate_hash(password),
            )
            .await
            .unwrap();
        let ordinary = db
            .create_user_and_join_users_group(
                "server-resource-viewer",
                password_auth::generate_hash(password),
            )
            .await
            .unwrap();
        add_admin_group(&db, admin.id).await;
        let manager = Arc::new(ClientManager::new(
            db.clone(),
            None,
            Default::default(),
            Arc::new(crate::FeatureFlags::default()),
            Arc::new(crate::webhook::WebhookConfig::new(
                None, None, None, None, None,
            )),
        ));
        assert!(manager.list_all_sessions().await.is_empty());
        let service = Arc::new(CentralNetworkService::new(db.clone(), manager.clone()));
        let session_store = tower_sessions_sqlx_store::SqliteStore::new(db.inner());
        session_store.migrate().await.unwrap();
        let session_layer =
            tower_sessions::SessionManagerLayer::new(session_store).with_secure(false);
        let auth_layer =
            AuthManagerLayerBuilder::new(Backend::new(db.clone()), session_layer).build();
        let app = router()
            .route_layer(login_required!(Backend))
            .merge(auth::router())
            .with_state(manager.clone())
            .layer(Extension(service))
            .layer(auth_layer);
        let request = |cookie: Option<&str>| {
            let mut request = Request::builder().uri("/api/v1/server/resources");
            if let Some(cookie) = cookie {
                request = request.header(header::COOKIE, cookie);
            }
            request.body(Body::empty()).unwrap()
        };
        let response = app.clone().oneshot(request(None)).await.unwrap();
        assert!(
            response.status() == StatusCode::UNAUTHORIZED || response.status().is_redirection()
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/server/resources")
                    .header(header::AUTHORIZATION, "Bearer metrics-read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            response.status() == StatusCode::UNAUTHORIZED || response.status().is_redirection()
        );
        let viewer_cookie = login(&app, &ordinary.username, password).await;
        let response = app
            .clone()
            .oneshot(request(Some(&viewer_cookie)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["code"], "server_resources_forbidden");
        assert!(body.get("host_resources").is_none());

        let admin_cookie = login(&app, &admin.username, password).await;
        let response = app
            .clone()
            .oneshot(request(Some(&admin_cookie)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(
            body["host_resources_supported"],
            host_resources::supported()
        );
        if host_resources::supported() {
            let resources = &body["host_resources"];
            let sampled_at = resources["sampled_at_unix_ms"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap();
            assert!(
                sampled_at > 0 && sampled_at <= chrono::Utc::now().timestamp_millis() as u64 + 1000
            );
            assert!(
                resources["memory_total_bytes"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 0
            );
            assert!(
                resources["process_rss_bytes"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    > 0
            );
            let repeated = host_resources::snapshot().await.unwrap();
            assert_eq!(
                repeated.sampled_at_unix_ms, sampled_at,
                "API and native callers must share the same process-wide cache"
            );
            assert_eq!(
                repeated.process_rss_bytes,
                Some(
                    resources["process_rss_bytes"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                )
            );
        }
        assert!(
            manager.list_all_sessions().await.is_empty(),
            "server observations must not require or create a managed Core"
        );
        remove_admin_group(&db, admin.id).await;
        let response = app.oneshot(request(Some(&admin_cookie))).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
