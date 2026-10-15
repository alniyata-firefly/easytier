//! Central-console device registration through the ordinary webhook contract.

use easytier::proto::web::DeviceOsInfo;
use uuid::Uuid;

use crate::{
    db::{Db, DeviceHeartbeatRecord},
    webhook::{ValidateTokenRequest, ValidateTokenResponse, WebhookHandler},
};

#[derive(Debug)]
pub struct DeviceAuth {
    db: Db,
}

impl DeviceAuth {
    pub fn new(db: Db, _allow_auto_create_user: bool) -> Self {
        Self { db }
    }
}

#[async_trait::async_trait]
impl WebhookHandler for DeviceAuth {
    fn uses_local_device_tokens(&self) -> bool {
        true
    }
    async fn validate_token(
        &self,
        request: &ValidateTokenRequest,
    ) -> anyhow::Result<ValidateTokenResponse> {
        let mut response = ValidateTokenResponse {
            valid: false,
            pre_approved: false,
            binding_version: 0,
            config_revision: String::new(),
        };
        let Ok(machine_id) = Uuid::parse_str(&request.machine_id) else {
            return Ok(response);
        };
        let identity = self
            .db
            .authenticate_device_access_token(
                &request.token,
                DeviceHeartbeatRecord {
                    // Ownership is resolved transactionally from the credential.
                    user_id: 0,
                    machine_id,
                    hostname: request.hostname.clone(),
                    easytier_version: request.version.clone(),
                    device_os: serde_json::to_string(&DeviceOsInfo {
                        os_type: request.os_type.clone().unwrap_or_default(),
                        version: request.os_version.clone().unwrap_or_default(),
                        distribution: request.os_distribution.clone().unwrap_or_default(),
                    })?,
                    client_url: String::new(),
                },
            )
            .await?;
        let Some(identity) = identity else {
            return Ok(response);
        };
        let device = (identity.user_id, machine_id);
        response.valid = true;
        response.pre_approved = true;
        response.binding_version = identity.auth_generation;
        response.config_revision = self
            .db
            .get_managed_config_revision(device)
            .await?
            .unwrap_or_default();
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use easytier::{
        common::config::{ConfigSource, NetworkConfig, NetworkConfigExt},
        instance::factory::native_instance_manager,
        proto::rpc::standalone::{runtime_udp_tunnel_dialer, runtime_udp_tunnel_listener},
        web_client::WebClient,
    };

    use crate::{
        FeatureFlags,
        client_manager::{ClientManager, HeartbeatPolicy},
        webhook::{ManagedNetworkConfig, WebhookConfig},
    };

    use super::*;

    async fn wait_until<F, Fut>(mut condition: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !condition().await {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("local device authentication did not converge");
    }

    async fn start_config_server(db: Db) -> (ClientManager, url::Url) {
        let webhook = WebhookConfig::new(None, None, None, None, None)
            .with_handler(Arc::new(DeviceAuth::new(db.clone(), false)));
        let mut manager = ClientManager::new(
            db,
            None,
            HeartbeatPolicy::from_millis(1_000, 10_000).unwrap(),
            Arc::new(FeatureFlags::default()),
            Arc::new(webhook),
        );
        let listener = runtime_udp_tunnel_listener(
            "udp://127.0.0.1:0".parse().unwrap(),
            "127.0.0.1:0".parse().unwrap(),
        );
        let url = manager.add_listener(listener).await.unwrap();
        (manager, url)
    }

    #[tokio::test]
    async fn web_client_registers_receives_full_config_and_cannot_reconnect_when_blocked() {
        let db = Db::memory_db().await;
        let user_id = db.auto_create_user("local-owner").await.unwrap().id;
        let token = db
            .create_device_access_token(user_id, "local-device", None, None)
            .await
            .unwrap()
            .token;
        let machine_id = Uuid::new_v4();
        let instance_id = Uuid::new_v4();
        let core = Arc::new(native_instance_manager());
        let (manager, url) = start_config_server(db.clone()).await;
        let client = WebClient::new(
            runtime_udp_tunnel_dialer(url),
            &token,
            machine_id,
            "local-device",
            false,
            core.clone(),
            None,
        );
        wait_until(|| async {
            db.get_device((user_id, machine_id))
                .await
                .unwrap()
                .is_some()
                && manager
                    .get_session_by_machine_id(user_id, &machine_id)
                    .is_some()
        })
        .await;
        assert_eq!(
            db.get_device((user_id, machine_id))
                .await
                .unwrap()
                .unwrap()
                .hostname,
            "local-device"
        );
        manager
            .reconcile_managed_network_configs(
                user_id,
                machine_id,
                vec![ManagedNetworkConfig {
                    instance_id: instance_id.to_string(),
                    network_config: serde_json::json!({
                        "instance_id": instance_id.to_string(),
                        "network_name": "local-managed-network",
                        "network_secret": "local-secret",
                        "networking_method": "Standalone",
                        "no_tun": true,
                        "disable_ipv6": true,
                        "multi_thread": false
                    }),
                }],
                Some("local-full-1".to_owned()),
                None,
            )
            .await
            .unwrap();
        wait_until(|| async {
            core.config(instance_id)
                .and_then(|config| NetworkConfig::new_from_config(&config).ok())
                .is_some_and(|config| {
                    config.network_name.as_deref() == Some("local-managed-network")
                })
        })
        .await;
        assert_eq!(core.config_source(instance_id), Some(ConfigSource::Web));

        // Stop the original connection before deleting it. This exercises a
        // fresh authentication, without depending on in-flight revocation.
        drop(client);
        manager
            .disconnect_session_by_machine_id(user_id, &machine_id)
            .await;
        drop(manager);
        db.delete_device_with_optional_block((user_id, machine_id), true)
            .await
            .unwrap();
        let (manager, url) = start_config_server(db.clone()).await;
        let blocked_token = db
            .create_device_access_token(user_id, "blocked-reenrollment", None, None)
            .await
            .unwrap()
            .token;
        let _blocked_client = WebClient::new(
            runtime_udp_tunnel_dialer(url),
            &blocked_token,
            machine_id,
            "blocked-device",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        // A second validation comes from another reconnect after the first
        // rejected session fails its next heartbeat.
        wait_until(|| async {
            db.list_blocked_devices(user_id)
                .await
                .unwrap()
                .first()
                .is_some_and(|blocked| blocked.attempt_count >= 2)
        })
        .await;
        assert!(
            db.get_device((user_id, machine_id))
                .await
                .unwrap()
                .is_none()
        );
        assert!(manager.list_sessions().await.is_empty());
        assert!(
            manager
                .get_session_by_machine_id(user_id, &machine_id)
                .is_none()
        );
        core.delete_network_instances([instance_id]).await.unwrap();
    }

    fn request(token: &str, machine_id: Uuid) -> ValidateTokenRequest {
        ValidateTokenRequest {
            token: token.to_owned(),
            machine_id: machine_id.to_string(),
            public_ip: Some("192.0.2.1".to_owned()),
            hostname: "device".to_owned(),
            version: "2.7.0".to_owned(),
            os_type: Some("Linux".to_owned()),
            os_version: Some("6.12".to_owned()),
            os_distribution: Some("Debian".to_owned()),
            web_instance_id: None,
            web_instance_api_base_url: None,
            persisted_config_revision: None,
            applied_config_revision: None,
            applied_config_revision_known: false,
            failed_instance_ids: Vec::new(),
        }
    }

    #[tokio::test]
    async fn live_revocation_retires_every_management_session_and_rotation_reconnects() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("rotation-owner").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let issued = db
            .create_device_access_token(owner, "laptop", None, None)
            .await
            .unwrap();
        let (manager, url) = start_config_server(db.clone()).await;
        let client = WebClient::new(
            runtime_udp_tunnel_dialer(url.clone()),
            issued.token.clone(),
            machine_id,
            "laptop",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        wait_until(|| async {
            manager
                .get_session_by_machine_id(owner, &machine_id)
                .is_some()
        })
        .await;
        let old_session = manager
            .get_session_by_machine_id(owner, &machine_id)
            .unwrap();
        assert!(old_session.management_access_valid().await);
        // Inventory is a management-only observation, including when a device
        // has no network Instances. It must obey the same live credential
        // revocation fence as configuration access.
        let inventory_request = || crate::restful::ProxyRpcRequest {
            service_name: "api.manage.WebClientService".to_owned(),
            method_name: "GetNetworkInterfaces".to_owned(),
            payload: serde_json::json!({}),
            scope: None,
        };
        crate::restful::handle_proxy_rpc_by_session(old_session.as_ref(), inventory_request())
            .await
            .expect("authorized device inventory must work without an Instance");
        let rotated = db
            .rotate_device_access_token(owner, &issued.info.id)
            .await
            .unwrap()
            .unwrap();
        // Management authorization expires at the DB commit, before asynchronous stop.
        assert!(!old_session.management_access_valid().await);
        let denied =
            crate::restful::handle_proxy_rpc_by_session(old_session.as_ref(), inventory_request())
                .await
                .expect_err("revoked device cannot expose Host interface inventory");
        assert_eq!(denied.0, axum::http::StatusCode::FORBIDDEN);
        manager
            .disconnect_sessions_by_device_token(
                owner,
                &issued.info.id,
                rotated.info.auth_generation,
            )
            .await;
        if let Some(hash) = rotated.retired_token_hash.as_deref() {
            manager.disconnect_sessions_by_device_token_hash(hash).await;
        }
        assert!(manager.list_sessions().await.is_empty());
        drop(client);
        let new_client = WebClient::new(
            runtime_udp_tunnel_dialer(url),
            rotated.token.clone(),
            machine_id,
            "laptop",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        wait_until(|| async {
            manager
                .get_session_by_machine_id(owner, &machine_id)
                .is_some()
        })
        .await;
        let new_session = manager
            .get_session_by_machine_id(owner, &machine_id)
            .unwrap();
        assert!(new_session.management_access_valid().await);
        let revoked = db
            .revoke_device_access_token(owner, &issued.info.id)
            .await
            .unwrap()
            .unwrap();
        manager
            .disconnect_sessions_by_device_token(owner, &issued.info.id, revoked.auth_generation)
            .await;
        assert!(!new_session.management_access_valid().await);
        assert!(!new_session.is_running());
        assert!(manager.list_sessions().await.is_empty());
        drop(new_client);
    }

    #[tokio::test]
    async fn revoke_device_access_worker_disconnects_and_physically_deletes_captured_credentials() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("worker-owner").await.unwrap().id;
        let other = db.auto_create_user("worker-other").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let elsewhere = Uuid::new_v4();
        let issued = db
            .create_device_access_token(owner, "live credential", Some(machine_id), None)
            .await
            .unwrap();
        let other_machine = db
            .create_device_access_token(owner, "other machine", Some(elsewhere), None)
            .await
            .unwrap();
        let other_owner = db
            .create_device_access_token(other, "other owner", Some(machine_id), None)
            .await
            .unwrap();
        let (manager, url) = start_config_server(db.clone()).await;
        let client = WebClient::new(
            runtime_udp_tunnel_dialer(url),
            issued.token.clone(),
            machine_id,
            "worker-device",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        wait_until(|| async {
            manager
                .get_session_by_machine_id(owner, &machine_id)
                .is_some()
        })
        .await;
        let session = manager
            .get_session_by_machine_id(owner, &machine_id)
            .unwrap();
        assert!(session.management_access_valid().await);

        manager
            .revoke_device_access(owner, machine_id)
            .await
            .unwrap();
        assert!(!session.is_running());
        assert!(!session.management_access_valid().await);
        assert!(manager.list_sessions().await.is_empty());
        assert!(
            db.get_device_access_token(owner, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.device_access_token_hash(owner, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(db.get_device((owner, machine_id)).await.unwrap().is_some());
        assert!(
            db.resolve_device_access_token(&issued.token, machine_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&other_machine.token, elsewhere)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            db.resolve_device_access_token(&other_owner.token, machine_id)
                .await
                .unwrap()
                .is_some()
        );
        drop(client);
    }

    #[tokio::test]
    async fn deleting_old_credentials_does_not_retire_a_freshly_enrolled_session() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("reenrollment-owner").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let old = db
            .create_device_access_token(owner, "old-device", None, None)
            .await
            .unwrap();
        let (manager, url) = start_config_server(db.clone()).await;
        let old_client = WebClient::new(
            runtime_udp_tunnel_dialer(url.clone()),
            old.token.clone(),
            machine_id,
            "device",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        wait_until(|| async {
            manager
                .get_session_by_machine_id(owner, &machine_id)
                .is_some()
        })
        .await;
        let old_session = manager
            .get_session_by_machine_id(owner, &machine_id)
            .unwrap();
        db.delete_device_with_optional_block((owner, machine_id), false)
            .await
            .unwrap();
        let fresh = db
            .create_device_access_token(owner, "fresh-device", Some(machine_id), None)
            .await
            .unwrap();
        let new_client = WebClient::new(
            runtime_udp_tunnel_dialer(url),
            fresh.token.clone(),
            machine_id,
            "device",
            false,
            Arc::new(native_instance_manager()),
            None,
        );
        wait_until(|| async {
            if let Some(session) = manager.get_session_by_machine_id(owner, &machine_id) {
                session
                    .get_token()
                    .await
                    .is_some_and(|token| token.token == fresh.token)
            } else {
                false
            }
        })
        .await;
        let new_session = manager
            .get_session_by_machine_id(owner, &machine_id)
            .unwrap();
        assert!(
            db.device_access_token_hash(owner, &old.info.id)
                .await
                .unwrap()
                .is_some(),
            "revoked metadata must remain until the retirement worker runs"
        );
        manager
            .retire_revoked_device_sessions(owner, machine_id)
            .await
            .unwrap();
        assert!(new_session.management_access_valid().await);
        assert!(new_session.is_running());
        assert!(!old_session.is_running());
        assert!(
            db.get_device_access_token(owner, &old.info.id)
                .await
                .unwrap()
                .is_none(),
            "the actual retirement worker deletes the old credential tombstone"
        );
        assert!(
            db.device_access_token_hash(owner, &old.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&fresh.token, machine_id)
                .await
                .unwrap()
                .is_some(),
            "fresh enrollment stays authorized after old credential retirement"
        );
        assert!(
            manager
                .get_session_by_machine_id(owner, &machine_id)
                .is_some()
        );
        drop(new_client);
        drop(old_client);
    }

    #[tokio::test]
    async fn central_auth_never_creates_users_from_unknown_tokens() {
        let db = Db::memory_db().await;
        let req = request("new-user", Uuid::new_v4());
        assert!(
            !DeviceAuth::new(db.clone(), false)
                .validate_token(&req)
                .await
                .unwrap()
                .valid
        );
        assert!(
            !DeviceAuth::new(db.clone(), true)
                .validate_token(&req)
                .await
                .unwrap()
                .valid
        );
        assert!(db.get_user_id("new-user").await.unwrap().is_none());
        let owner = db.auto_create_user("owner").await.unwrap().id;
        assert!(
            !DeviceAuth::new(db.clone(), true)
                .validate_token(&request("owner", Uuid::new_v4()))
                .await
                .unwrap()
                .valid
        );
        let issued = db
            .create_device_access_token(owner, "new-device", None, None)
            .await
            .unwrap();
        let mut req = request(&issued.token, Uuid::new_v4());
        let id = req.machine_id.clone();
        req.machine_id = "invalid".into();
        assert!(
            !DeviceAuth::new(db.clone(), true)
                .validate_token(&req)
                .await
                .unwrap()
                .valid
        );
        assert_eq!(
            db.get_device_access_token(owner, &issued.info.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "pending"
        );
        req.machine_id = id;
        assert!(
            DeviceAuth::new(db.clone(), false)
                .validate_token(&req)
                .await
                .unwrap()
                .valid
        );
        assert_eq!(db.list_devices(owner).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn registration_refreshes_metadata_and_preserves_alias_and_address() {
        let db = Db::memory_db().await;
        let user_id = db.auto_create_user("owner").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let device = (user_id, machine_id);
        let auth = DeviceAuth::new(db.clone(), false);
        let token = db
            .create_device_access_token(user_id, "device", None, None)
            .await
            .unwrap()
            .token;
        let mut req = request(&token, machine_id);
        let response = auth.validate_token(&req).await.unwrap();
        assert!(response.valid && response.pre_approved);
        let initial = db.get_device(device).await.unwrap().unwrap();
        assert!(initial.client_url.is_empty());
        db.set_device_alias(device, "office".to_owned())
            .await
            .unwrap();
        db.upsert_device_heartbeat(DeviceHeartbeatRecord {
            user_id,
            machine_id,
            hostname: initial.hostname,
            easytier_version: initial.easytier_version,
            device_os: initial.device_os,
            client_url: "tcp://192.0.2.2:1234".to_owned(),
        })
        .await
        .unwrap();
        db.set_managed_config_revision(device, "revision-1")
            .await
            .unwrap();
        req.hostname = "renamed".to_owned();
        req.version = "2.8.0".to_owned();
        assert_eq!(
            auth.validate_token(&req).await.unwrap().config_revision,
            "revision-1"
        );
        let refreshed = db.get_device(device).await.unwrap().unwrap();
        assert_eq!(refreshed.hostname, "renamed");
        assert_eq!(refreshed.easytier_version, "2.8.0");
        assert_eq!(refreshed.alias, "office");
        assert_eq!(refreshed.client_url, "tcp://192.0.2.2:1234");
        assert_eq!(refreshed.first_seen_time, initial.first_seen_time);
        let os: DeviceOsInfo = serde_json::from_str(&refreshed.device_os).unwrap();
        assert_eq!(os.os_type, "Linux");
        assert_eq!(os.version, "6.12");
        assert_eq!(os.distribution, "Debian");
    }

    #[tokio::test]
    async fn deletion_revokes_old_tokens_and_blocking_rejects_fresh_enrollment() {
        let db = Db::memory_db().await;
        let user_id = db.auto_create_user("owner").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let device = (user_id, machine_id);
        let auth = DeviceAuth::new(db.clone(), false);
        let token = db
            .create_device_access_token(user_id, "device", None, None)
            .await
            .unwrap()
            .token;
        let mut req = request(&token, machine_id);
        assert!(auth.validate_token(&req).await.unwrap().valid);
        assert!(
            db.delete_device_with_optional_block(device, false)
                .await
                .unwrap()
        );
        assert!(db.get_device(device).await.unwrap().is_none());
        assert!(!auth.validate_token(&req).await.unwrap().valid);
        let new_token = db
            .create_device_access_token(user_id, "fresh-enrollment", None, None)
            .await
            .unwrap()
            .token;
        req.token = new_token;
        assert!(auth.validate_token(&req).await.unwrap().valid);

        assert!(
            db.delete_device_with_optional_block(device, true)
                .await
                .unwrap()
        );
        req.hostname = "blocked-retry".to_owned();
        let blocked_token = db
            .create_device_access_token(user_id, "blocked-retry", None, None)
            .await
            .unwrap()
            .token;
        req.token = blocked_token;
        assert!(!auth.validate_token(&req).await.unwrap().valid);
        assert!(!auth.validate_token(&req).await.unwrap().valid);
        assert!(db.get_device(device).await.unwrap().is_none());
        let blocked = db.list_blocked_devices(user_id).await.unwrap();
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].hostname, "blocked-retry");
        assert_eq!(blocked[0].attempt_count, 2);
        assert!(blocked[0].last_attempt_time.is_some());
        assert!(db.unblock_device(device).await.unwrap());
        assert!(auth.validate_token(&req).await.unwrap().valid);
    }

    #[tokio::test]
    async fn registration_and_blocks_are_scoped_to_the_token_tenant() {
        let db = Db::memory_db().await;
        let user_a = db.auto_create_user("tenant-a").await.unwrap().id;
        let user_b = db.auto_create_user("tenant-b").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let auth = DeviceAuth::new(db.clone(), false);
        let token_a = db
            .create_device_access_token(user_a, "device-a", None, None)
            .await
            .unwrap()
            .token;
        let req_a = request(&token_a, machine_id);
        assert!(auth.validate_token(&req_a).await.unwrap().valid);
        db.delete_device_with_optional_block((user_a, machine_id), true)
            .await
            .unwrap();
        let token_b = db
            .create_device_access_token(user_b, "device-b", None, None)
            .await
            .unwrap()
            .token;
        let mut req_b = request(&token_b, machine_id);
        req_b.hostname = "tenant-b-host".to_owned();
        assert!(auth.validate_token(&req_b).await.unwrap().valid);
        assert!(!auth.validate_token(&req_a).await.unwrap().valid);
        assert!(db.get_device((user_a, machine_id)).await.unwrap().is_none());
        assert_eq!(
            db.get_device((user_b, machine_id))
                .await
                .unwrap()
                .unwrap()
                .hostname,
            "tenant-b-host"
        );
        assert!(db.list_blocked_devices(user_b).await.unwrap().is_empty());
    }
}
