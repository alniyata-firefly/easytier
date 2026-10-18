//! Administrator-only observations of this Web server process.

use std::sync::Arc;

use axum::{
    Extension, Json, Router,
    extract::{Query, rejection::QueryRejection},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::get,
};

use crate::{
    central_network::service::CentralNetworkService,
    server_logs::{ServerLogPage, ServerLogQuery, ServerLogs},
};

use super::{
    AppStateInner, HttpHandleError, authed_user_id, other_error, server_resources::ensure_admin,
    users::AuthSession,
};

fn query_error(message: &'static str) -> HttpHandleError {
    let mut error = other_error(message);
    error.code = Some("server_logs_invalid_query".to_owned());
    (StatusCode::BAD_REQUEST, Json(error))
}

async fn logs(
    auth: AuthSession,
    Extension(service): Extension<Arc<CentralNetworkService>>,
    Extension(logs): Extension<Arc<ServerLogs>>,
    query: Result<Query<ServerLogQuery>, QueryRejection>,
) -> Result<Json<ServerLogPage>, HttpHandleError> {
    let user_id = authed_user_id(&auth)?;
    ensure_admin(&service.db, user_id)
        .await
        .map_err(|(status, mut error)| {
            if status == StatusCode::FORBIDDEN {
                error.0 = other_error("server logs require administrator access");
                error.0.code = Some("server_logs_forbidden".to_owned());
            }
            (status, error)
        })?;
    // Never echo the rejected query: it could itself contain a pasted token.
    let Query(query) = query.map_err(|_| query_error("invalid server log query"))?;
    let page = logs.page(&query).map_err(query_error)?;
    Ok(Json(page))
}

async fn no_store(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

pub(super) fn router() -> Router<AppStateInner> {
    Router::new()
        .route("/api/v1/server/logs", get(logs))
        .layer(middleware::from_fn(no_store))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use axum_login::AuthManagerLayerBuilder;
    use tower::ServiceExt as _;

    use crate::{
        client_manager::ClientManager,
        db::{Db, UserIdInDb},
        restful::{auth, users::Backend},
        server_logs::tests::capture,
    };

    async fn grant_admin(db: &Db, user_id: UserIdInDb) {
        assert_eq!(sqlx::query("INSERT INTO users_groups(user_id,group_id) SELECT ?,id FROM groups WHERE name='admins'")
            .bind(user_id).execute(&db.inner()).await.unwrap().rows_affected(), 1);
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
                            &serde_json::json!({"username": username, "password": password}),
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

    fn request(uri: &str, cookie: Option<&str>) -> Request<Body> {
        let mut request = Request::builder().uri(uri);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn actual_router_checks_current_admin_role_and_returns_safe_filtered_events() {
        let db = Db::memory_db().await;
        let password = "server-logs-fixture-password";
        let admin = db
            .create_user_and_join_users_group(
                "server-log-operator",
                password_auth::generate_hash(password),
            )
            .await
            .unwrap();
        let ordinary = db
            .create_user_and_join_users_group(
                "server-log-viewer",
                password_auth::generate_hash(password),
            )
            .await
            .unwrap();
        grant_admin(&db, admin.id).await;
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
        let logs = Arc::new(ServerLogs::new());
        capture(logs.clone(), || {
            tracing::info!(target: "easytier_web", "easytier-web starting");
            tracing::warn!(target: "easytier_web::client_manager", user_id = 42, error = "canary-credential", "Failed to handle heartbeat: canary-credential");
        });
        let session_store = tower_sessions_sqlx_store::SqliteStore::new(db.inner());
        session_store.migrate().await.unwrap();
        let session_layer =
            tower_sessions::SessionManagerLayer::new(session_store).with_secure(false);
        let auth_layer =
            AuthManagerLayerBuilder::new(Backend::new(db.clone()), session_layer).build();
        // The handler also enforces authentication itself, independently of the
        // larger application router's login-required middleware.
        let app = router()
            .merge(auth::router())
            .with_state(manager.clone())
            .layer(Extension(service))
            .layer(Extension(logs))
            .layer(auth_layer);

        let anonymous = app
            .clone()
            .oneshot(request("/api/v1/server/logs", None))
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(anonymous.headers()[header::CACHE_CONTROL], "no-store");
        let bearer = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/server/logs")
                    .header(header::AUTHORIZATION, "Bearer metrics-read-only-token")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bearer.status(), StatusCode::UNAUTHORIZED);

        let viewer_cookie = login(&app, &ordinary.username, password).await;
        let denied = app
            .clone()
            .oneshot(request("/api/v1/server/logs", Some(&viewer_cookie)))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let denied: serde_json::Value =
            serde_json::from_slice(&to_bytes(denied.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(denied["code"], "server_logs_forbidden");
        assert!(denied.get("entries").is_none());

        let cookie = login(&app, &admin.username, password).await;
        let response = app
            .clone()
            .oneshot(request(
                "/api/v1/server/logs?level=WARN&q=heartbeat&limit=1",
                Some(&cookie),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        assert!(
            !std::str::from_utf8(&body)
                .unwrap()
                .contains("canary-credential")
        );
        let page: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(page["entries"].as_array().unwrap().len(), 1);
        assert_eq!(page["entries"][0]["level"], "WARN");
        assert_eq!(page["entries"][0]["fields"]["user_id"], "42");
        assert_eq!(page["capacity"], 2000);
        assert!(uuid::Uuid::parse_str(page["instance_id"].as_str().unwrap()).is_ok());
        assert!(manager.list_all_sessions().await.is_empty());

        for query in [
            "limit=0",
            "limit=201",
            "before_id=0",
            "before_id=9007199254740992",
            "level=DEBUG",
            "unknown=canary-credential",
        ] {
            let response = app
                .clone()
                .oneshot(request(
                    &format!("/api/v1/server/logs?{query}"),
                    Some(&cookie),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(
                !std::str::from_utf8(&body)
                    .unwrap()
                    .contains("canary-credential")
            );
        }
        // A live session must not retain access after its role is removed.
        sqlx::query("DELETE FROM users_groups WHERE user_id=? AND group_id IN (SELECT id FROM groups WHERE name='admins')")
            .bind(admin.id).execute(&db.inner()).await.unwrap();
        let revoked = app
            .oneshot(request("/api/v1/server/logs", Some(&cookie)))
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
    }
}
