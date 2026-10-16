//! Explicit recovery of a management identity after a reinstall. A request is
//! evidence of possession of an effective token, never authorization by itself.
use chrono::{SecondsFormat, Utc};
use sea_orm::DbErr;
use sqlx::{Row as _, Sqlite, Transaction};
use uuid::Uuid;

use super::{Db, DeviceHeartbeatRecord, UserIdInDb, sqlx_db_error};

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct DeviceRebindRequestInfo {
    pub id: String,
    pub token_id: String,
    pub token_label: String,
    pub old_machine_id: String,
    pub new_machine_id: String,
    pub old_device_alias: String,
    pub old_hostname: String,
    pub hostname: String,
    pub easytier_version: String,
    pub device_os: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub attempt_count: i64,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct DeviceRebindApproval {
    pub request_id: String,
    pub old_machine_id: String,
    pub new_machine_id: String,
    pub token_id: String,
    pub auth_generation: u64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum DeviceRebindError {
    #[error("Device recovery request not found")]
    NotFound,
    #[error("{0}")]
    Conflict(&'static str),
    #[error(transparent)]
    Database(#[from] DbErr),
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bounded(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Called inside the same immediate transaction that resolved the token. No
/// unknown, expired, revoked or blocked credential can manufacture a request.
pub(super) async fn record_mismatch(
    transaction: &mut Transaction<'_, Sqlite>,
    owner: UserIdInDb,
    token_id: &str,
    auth_generation: i64,
    old_machine_id: &str,
    record: &DeviceHeartbeatRecord,
) -> Result<(), DbErr> {
    let new_machine_id = record.machine_id.to_string();
    let blocked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocked_devices WHERE user_id=? AND machine_id IN (?,?)",
    )
    .bind(owner)
    .bind(old_machine_id)
    .bind(&new_machine_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(sqlx_db_error)?;
    if blocked != 0 {
        return Ok(());
    }
    let old_exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?")
            .bind(owner)
            .bind(old_machine_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(sqlx_db_error)?;
    if old_exists == 0 {
        return Ok(());
    }
    // Keep actively retried rejections for this credential generation. Requests
    // idle for seven days expire in every state, so hidden entries cannot keep
    // consuming the bounded queue forever. Continuous rejected retries refresh
    // last_seen_at below without reopening the approval request.
    let now = now_string();
    let cutoff =
        (Utc::now() - chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query(r#"
        DELETE FROM device_rebind_requests WHERE user_id=?
            AND (last_seen_at<=? OR NOT EXISTS (
                SELECT 1 FROM device_access_tokens t
                WHERE t.id=device_rebind_requests.token_id AND t.user_id=device_rebind_requests.user_id
                    AND t.auth_generation=device_rebind_requests.auth_generation
                    AND t.machine_id=device_rebind_requests.old_machine_id
                    AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
            ))
    "#).bind(owner).bind(cutoff).bind(&now).execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    let refreshed = sqlx::query("UPDATE device_rebind_requests SET last_seen_at=?,attempt_count=MIN(attempt_count+1,2147483647),hostname=?,easytier_version=?,device_os=? WHERE user_id=? AND token_id=? AND auth_generation=? AND new_machine_id=?")
        .bind(&now).bind(bounded(&record.hostname,128)).bind(bounded(&record.easytier_version,128)).bind(bounded(&record.device_os,2048))
        .bind(owner).bind(token_id).bind(auth_generation).bind(&new_machine_id)
        .execute(&mut **transaction).await.map_err(sqlx_db_error)?.rows_affected();
    if refreshed != 0 {
        return Ok(());
    }
    let token_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=? AND token_id=? AND auth_generation=?")
        .bind(owner).bind(token_id).bind(auth_generation).fetch_one(&mut **transaction).await.map_err(sqlx_db_error)?;
    let owner_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=?")
            .bind(owner)
            .fetch_one(&mut **transaction)
            .await
            .map_err(sqlx_db_error)?;
    if token_count >= 16 || owner_count >= 256 {
        return Ok(());
    }
    sqlx::query("INSERT INTO device_rebind_requests (id,user_id,token_id,auth_generation,old_machine_id,new_machine_id,hostname,easytier_version,device_os,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(Uuid::new_v4().to_string()).bind(owner).bind(token_id).bind(auth_generation)
        .bind(old_machine_id).bind(new_machine_id).bind(bounded(&record.hostname,128)).bind(bounded(&record.easytier_version,128)).bind(bounded(&record.device_os,2048)).bind(&now).bind(&now)
        .execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    Ok(())
}

impl Db {
    pub(crate) async fn has_pending_device_rebind(
        &self,
        token: &str,
        machine_id: Uuid,
    ) -> Result<bool, DbErr> {
        let cutoff =
            (Utc::now() - chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let found: i64 = sqlx::query_scalar(r#"
            SELECT COUNT(*) FROM device_rebind_requests r
            JOIN device_access_tokens t ON t.id=r.token_id AND t.user_id=r.user_id
                AND t.auth_generation=r.auth_generation AND t.machine_id=r.old_machine_id
            JOIN devices d ON d.user_id=r.user_id AND d.machine_id=r.old_machine_id
            WHERE t.token_hash=? AND r.new_machine_id=? AND r.status='pending' AND r.last_seen_at>?
                AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
                AND NOT EXISTS (SELECT 1 FROM blocked_devices b WHERE b.user_id=r.user_id AND b.machine_id IN (r.old_machine_id,r.new_machine_id))
        "#).bind(super::device_access_tokens::token_hash(token)).bind(machine_id.to_string()).bind(cutoff).bind(now_string())
            .fetch_one(&self.db).await.map_err(sqlx_db_error)?;
        Ok(found != 0)
    }

    pub(crate) async fn list_device_rebind_requests(
        &self,
        owner: UserIdInDb,
    ) -> Result<Vec<DeviceRebindRequestInfo>, DbErr> {
        let cutoff =
            (Utc::now() - chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let rows = sqlx::query(r#"
            SELECT r.*, t.label AS token_label, d.alias AS old_device_alias, d.hostname AS old_hostname
            FROM device_rebind_requests r
            JOIN device_access_tokens t ON t.id=r.token_id AND t.user_id=r.user_id
                AND t.auth_generation=r.auth_generation AND t.machine_id=r.old_machine_id
            JOIN devices d ON d.user_id=r.user_id AND d.machine_id=r.old_machine_id
            WHERE r.user_id=? AND r.status='pending' AND r.last_seen_at>?
                AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
                AND NOT EXISTS (SELECT 1 FROM blocked_devices b WHERE b.user_id=r.user_id AND b.machine_id IN (r.old_machine_id,r.new_machine_id))
            ORDER BY r.last_seen_at DESC,r.id
        "#).bind(owner).bind(cutoff).bind(now_string()).fetch_all(&self.db).await.map_err(sqlx_db_error)?;
        rows.iter()
            .map(|row| {
                Ok(DeviceRebindRequestInfo {
                    id: row.try_get("id").map_err(sqlx_db_error)?,
                    token_id: row.try_get("token_id").map_err(sqlx_db_error)?,
                    token_label: row.try_get("token_label").map_err(sqlx_db_error)?,
                    old_machine_id: row.try_get("old_machine_id").map_err(sqlx_db_error)?,
                    new_machine_id: row.try_get("new_machine_id").map_err(sqlx_db_error)?,
                    old_device_alias: row.try_get("old_device_alias").map_err(sqlx_db_error)?,
                    old_hostname: row.try_get("old_hostname").map_err(sqlx_db_error)?,
                    hostname: row.try_get("hostname").map_err(sqlx_db_error)?,
                    easytier_version: row.try_get("easytier_version").map_err(sqlx_db_error)?,
                    device_os: row.try_get("device_os").map_err(sqlx_db_error)?,
                    created_at: row.try_get("created_at").map_err(sqlx_db_error)?,
                    last_seen_at: row.try_get("last_seen_at").map_err(sqlx_db_error)?,
                    attempt_count: row.try_get("attempt_count").map_err(sqlx_db_error)?,
                    status: row.try_get("status").map_err(sqlx_db_error)?,
                })
            })
            .collect()
    }

    pub(crate) async fn reject_device_rebind_request(
        &self,
        owner: UserIdInDb,
        id: Uuid,
    ) -> Result<(), DeviceRebindError> {
        let _auth = self.device_auth_gate.write().await;
        let changed = sqlx::query("UPDATE device_rebind_requests SET status='rejected',decided_at=? WHERE user_id=? AND id=? AND status='pending'")
            .bind(now_string()).bind(owner).bind(id.to_string()).execute(&self.db).await.map_err(sqlx_db_error)?.rows_affected();
        if changed == 0 {
            return Err(DeviceRebindError::NotFound);
        }
        Ok(())
    }

    /// Atomically changes the management identity without recompiling network
    /// intent: member IDs, allocated IPs, VPN credentials and config bytes stay
    /// intact. The auth fence also excludes in-flight runtime publication.
    pub(crate) async fn approve_device_rebind_request(
        &self,
        owner: UserIdInDb,
        id: Uuid,
    ) -> Result<DeviceRebindApproval, DeviceRebindError> {
        let _auth = self.device_auth_gate.write().await;
        let mut transaction = self
            .db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(sqlx_db_error)?;
        let row = sqlx::query("SELECT * FROM device_rebind_requests WHERE user_id=? AND id=?")
            .bind(owner)
            .bind(id.to_string())
            .fetch_optional(&mut *transaction)
            .await
            .map_err(sqlx_db_error)?
            .ok_or(DeviceRebindError::NotFound)?;
        let state: String = row.try_get("status").map_err(sqlx_db_error)?;
        if state != "pending" {
            return Err(DeviceRebindError::Conflict(
                "Recovery request was already decided",
            ));
        }
        let token_id: String = row.try_get("token_id").map_err(sqlx_db_error)?;
        let generation: i64 = row.try_get("auth_generation").map_err(sqlx_db_error)?;
        let old: String = row.try_get("old_machine_id").map_err(sqlx_db_error)?;
        let new: String = row.try_get("new_machine_id").map_err(sqlx_db_error)?;
        if Uuid::parse_str(&old).is_err() || Uuid::parse_str(&new).is_err() {
            return Err(DeviceRebindError::Conflict("Recovery identity is invalid"));
        }
        let now = now_string();
        let cutoff =
            (Utc::now() - chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_access_tokens t WHERE t.user_id=? AND t.id=? AND t.auth_generation=? AND t.machine_id=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND NOT EXISTS (SELECT 1 FROM blocked_devices b WHERE b.user_id=t.user_id AND b.machine_id IN (?,?))")
            .bind(owner).bind(&token_id).bind(generation).bind(&old).bind(&now).bind(&old).bind(&new)
            .fetch_one(&mut *transaction).await.map_err(sqlx_db_error)?;
        let last_seen: String = row.try_get("last_seen_at").map_err(sqlx_db_error)?;
        if valid == 0 || last_seen <= cutoff || old == new {
            return Err(DeviceRebindError::Conflict(
                "Recovery request is stale; reconnect with the current credential",
            ));
        }
        let old_exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?")
                .bind(owner)
                .bind(&old)
                .fetch_one(&mut *transaction)
                .await
                .map_err(sqlx_db_error)?;
        if old_exists != 1 {
            return Err(DeviceRebindError::Conflict(
                "Original device no longer exists",
            ));
        }
        let conflicts: i64 = sqlx::query_scalar(r#"
            SELECT (SELECT COUNT(*) FROM devices WHERE user_id=? AND machine_id=?)
                + (SELECT COUNT(*) FROM user_running_network_configs WHERE user_id=? AND device_id=?)
                + (SELECT COUNT(*) FROM managed_config_revisions WHERE user_id=? AND device_id=?)
                + (SELECT COUNT(*) FROM network_members WHERE user_id=? AND device_id=?)
                + (SELECT COUNT(*) FROM device_access_tokens WHERE user_id=? AND id<>? AND machine_id IN (?,?) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))
        "#).bind(owner).bind(&new).bind(owner).bind(&new).bind(owner).bind(&new).bind(owner).bind(&new)
            .bind(owner).bind(&token_id).bind(&old).bind(&new).bind(&now)
            .fetch_one(&mut *transaction).await.map_err(sqlx_db_error)?;
        if conflicts != 0 {
            return Err(DeviceRebindError::Conflict(
                "Replacement device already has an identity, credential or configuration",
            ));
        }
        sqlx::query("UPDATE devices SET machine_id=?,hostname=?,easytier_version=?,device_os=?,client_url='',last_seen_time=? WHERE user_id=? AND machine_id=?")
            .bind(&new).bind(row.try_get::<String,_>("hostname").map_err(sqlx_db_error)?)
            .bind(row.try_get::<String,_>("easytier_version").map_err(sqlx_db_error)?)
            .bind(row.try_get::<String,_>("device_os").map_err(sqlx_db_error)?)
            .bind(&now).bind(owner).bind(&old).execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        // network_members follows the composite devices foreign key through
        // ON UPDATE CASCADE. These two tables intentionally have only user FKs.
        for table in ["user_running_network_configs", "managed_config_revisions"] {
            sqlx::query(&format!(
                "UPDATE {table} SET device_id=? WHERE user_id=? AND device_id=?"
            ))
            .bind(&new)
            .bind(owner)
            .bind(&old)
            .execute(&mut *transaction)
            .await
            .map_err(sqlx_db_error)?;
        }
        sqlx::query("UPDATE device_access_tokens SET machine_id=?,bound_at=?,last_used_at=NULL,auth_generation=auth_generation+1 WHERE user_id=? AND id=?")
            .bind(&new).bind(&now).bind(owner).bind(&token_id).execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        sqlx::query("UPDATE device_rebind_requests SET status=CASE WHEN id=? THEN 'approved' ELSE 'superseded' END,decided_at=? WHERE user_id=? AND token_id=? AND auth_generation=? AND status='pending'")
            .bind(id.to_string()).bind(&now).bind(owner).bind(&token_id).bind(generation)
            .execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        transaction.commit().await.map_err(sqlx_db_error)?;
        Ok(DeviceRebindApproval {
            request_id: id.to_string(),
            old_machine_id: old,
            new_machine_id: new,
            token_id,
            auth_generation: (generation + 1) as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(machine_id: Uuid) -> DeviceHeartbeatRecord {
        DeviceHeartbeatRecord {
            user_id: 0,
            machine_id,
            hostname: "reinstalled-phone".into(),
            easytier_version: "2.7.2-test".into(),
            device_os: r#"{"os_type":"Android","version":"15","distribution":"iQOO"}"#.into(),
            client_url: String::new(),
        }
    }

    async fn fixture() -> (Db, UserIdInDb, String, String, Uuid, Uuid) {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("rebind-owner").await.unwrap().id;
        let old = Uuid::new_v4();
        let new = Uuid::new_v4();
        let issued = db
            .create_device_access_token(owner, "phone", None, None)
            .await
            .unwrap();
        assert!(
            db.authenticate_device_access_token(&issued.token, record(old))
                .await
                .unwrap()
                .is_some()
        );
        db.set_device_alias((owner, old), "my phone".into())
            .await
            .unwrap();
        (db, owner, issued.token, issued.info.id, old, new)
    }

    async fn request(db: &Db, owner: UserIdInDb, token: &str, new: Uuid) -> Uuid {
        assert!(
            db.authenticate_device_access_token(token, record(new))
                .await
                .unwrap()
                .is_none()
        );
        let pending = db.list_device_rebind_requests(owner).await.unwrap();
        Uuid::parse_str(
            &pending
                .iter()
                .find(|r| r.new_machine_id == new.to_string())
                .unwrap()
                .id,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn approval_preserves_member_address_credentials_acl_and_config_bytes() {
        let (db, owner, token, token_id, old, new) = fixture().await;
        let network = Uuid::new_v4().to_string();
        let member = Uuid::new_v4().to_string();
        let credential = old.to_string();
        let config = "{\n  \"network_name\":\"vpn\", \"instance_name\":\"phone\", \"ipv4\":\"100.64.4.5\"\n}";
        sqlx::query("INSERT INTO networks (user_id,id,display_name,network_name,network_secret,networking_method,acl_policy,create_time,update_time) VALUES (?,?, 'VPN','vpn','vpn-secret','Standalone','{\"rules\":[]}',?,?)")
            .bind(owner).bind(&network).bind(now_string()).bind(now_string()).execute(&db.db).await.unwrap();
        sqlx::query("INSERT INTO network_credentials (user_id,network_id,credential_id,credential_secret,expiry_unix,acl_groups,allow_relay,allowed_proxy_cidrs,reusable,create_time,update_time) VALUES (?,?,?,'vpn-credential-secret',2000000000,'[\"phones\"]',1,'[\"10.5.0.0/24\"]',0,?,?)")
            .bind(owner).bind(&network).bind(&credential).bind(now_string()).bind(now_string()).execute(&db.db).await.unwrap();
        sqlx::query("INSERT INTO network_members (user_id,network_id,id,device_id,hostname_override,allocated_ipv4,override_config,credential_id,create_time,update_time) VALUES (?,?,?,?,'Mobile','100.64.4.5','{\"no_tun\":false}',?,?,?)")
            .bind(owner).bind(&network).bind(&member).bind(old.to_string()).bind(&credential).bind(now_string()).bind(now_string()).execute(&db.db).await.unwrap();
        sqlx::query("INSERT INTO user_running_network_configs (user_id,device_id,network_instance_id,network_config,source,disabled,create_time,update_time) VALUES (?,?,?,?,'web',0,?,?)")
            .bind(owner).bind(old.to_string()).bind(&network).bind(config).bind(now_string()).bind(now_string()).execute(&db.db).await.unwrap();
        db.set_managed_config_revision((owner, old), "central:unchanged")
            .await
            .unwrap();
        let before = db.get_device((owner, old)).await.unwrap().unwrap();
        let id = request(&db, owner, &token, new).await;
        assert!(db.get_device((owner, new)).await.unwrap().is_none());
        assert!(
            db.resolve_device_access_token(&token, new)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.get_managed_config_revision((owner, new))
                .await
                .unwrap()
                .is_none()
        );
        let approved = db.approve_device_rebind_request(owner, id).await.unwrap();
        assert_eq!(approved.auth_generation, 2);
        assert_eq!(approved.token_id, token_id);
        assert!(db.get_device((owner, old)).await.unwrap().is_none());
        let device = db.get_device((owner, new)).await.unwrap().unwrap();
        assert_eq!(device.alias, "my phone");
        assert_eq!(device.first_seen_time, before.first_seen_time);
        assert!(device.client_url.is_empty());
        let migrated = sqlx::query("SELECT * FROM network_members WHERE user_id=? AND id=?")
            .bind(owner)
            .bind(&member)
            .fetch_one(&db.db)
            .await
            .unwrap();
        assert_eq!(migrated.get::<String, _>("id"), member);
        assert_eq!(migrated.get::<String, _>("device_id"), new.to_string());
        assert_eq!(migrated.get::<String, _>("allocated_ipv4"), "100.64.4.5");
        assert_eq!(migrated.get::<String, _>("credential_id"), credential);
        assert_eq!(
            migrated.get::<String, _>("override_config"),
            "{\"no_tun\":false}"
        );
        let moved: String = sqlx::query_scalar("SELECT network_config FROM user_running_network_configs WHERE user_id=? AND device_id=?")
            .bind(owner).bind(new.to_string()).fetch_one(&db.db).await.unwrap();
        assert_eq!(moved, config);
        assert_eq!(
            db.get_managed_config_revision((owner, new))
                .await
                .unwrap()
                .as_deref(),
            Some("central:unchanged")
        );
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT credential_secret FROM network_credentials WHERE user_id=? AND network_id=? AND credential_id=?").bind(owner).bind(&network).bind(&credential).fetch_one(&db.db).await.unwrap(),"vpn-credential-secret");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT acl_policy FROM networks WHERE user_id=? AND id=?"
            )
            .bind(owner)
            .bind(&network)
            .fetch_one(&db.db)
            .await
            .unwrap(),
            "{\"rules\":[]}"
        );
        assert!(
            db.resolve_device_access_token(&token, old)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            db.authenticate_device_access_token(&token, record(new))
                .await
                .unwrap()
                .unwrap()
                .auth_generation,
            2
        );
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            db.approve_device_rebind_request(owner, id).await,
            Err(DeviceRebindError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn rejected_request_does_not_reappear_and_never_authorizes_new_identity() {
        let (db, owner, token, _, old, new) = fixture().await;
        let id = request(&db, owner, &token, new).await;
        assert!(db.has_pending_device_rebind(&token, new).await.unwrap());
        db.reject_device_rebind_request(owner, id).await.unwrap();
        for _ in 0..3 {
            assert!(
                db.authenticate_device_access_token(&token, record(new))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(!db.has_pending_device_rebind(&token, new).await.unwrap());
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(db.get_device((owner, new)).await.unwrap().is_none());
        assert!(
            db.resolve_device_access_token(&token, old)
                .await
                .unwrap()
                .is_some()
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=?")
                .bind(owner)
                .fetch_one(&db.db)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert!(matches!(
            db.approve_device_rebind_request(owner, id).await,
            Err(DeviceRebindError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn recovery_is_owner_scoped_and_stale_after_rotation_revocation_expiry_or_block() {
        for invalidation in ["rotate", "revoke", "expire", "old-block", "new-block"] {
            let (db, owner, token, token_id, old, new) = fixture().await;
            let other = db.auto_create_user("other-owner").await.unwrap().id;
            let id = request(&db, owner, &token, new).await;
            assert!(
                db.list_device_rebind_requests(other)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(matches!(
                db.approve_device_rebind_request(other, id).await,
                Err(DeviceRebindError::NotFound)
            ));
            assert!(matches!(
                db.reject_device_rebind_request(other, id).await,
                Err(DeviceRebindError::NotFound)
            ));
            match invalidation {
                "rotate" => {
                    db.rotate_device_access_token(owner, &token_id)
                        .await
                        .unwrap()
                        .unwrap();
                }
                "revoke" => {
                    db.revoke_device_access_token(owner, &token_id)
                        .await
                        .unwrap()
                        .unwrap();
                }
                "expire" => {
                    sqlx::query("UPDATE device_access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(&token_id).execute(&db.db).await.unwrap();
                }
                blocked => {
                    sqlx::query("INSERT INTO blocked_devices (user_id,machine_id,blocked_time) VALUES (?,?,?)").bind(owner).bind(if blocked=="old-block" {old} else {new}.to_string()).bind(now_string()).execute(&db.db).await.unwrap();
                }
            }
            assert!(
                db.list_device_rebind_requests(owner)
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(!db.has_pending_device_rebind(&token, new).await.unwrap());
            assert!(matches!(
                db.approve_device_rebind_request(owner, id).await,
                Err(DeviceRebindError::Conflict(_))
            ));
            assert!(db.get_device((owner, old)).await.unwrap().is_some());
            assert!(db.get_device((owner, new)).await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn invalid_tokens_do_not_create_requests_and_queue_has_no_secret_material() {
        let (db, owner, token, token_id, old, new) = fixture().await;
        for value in ["unknown", "rebind-owner"] {
            assert!(
                db.authenticate_device_access_token(value, record(new))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        let id = request(&db, owner, &token, new).await;
        let exposed =
            serde_json::to_string(&db.list_device_rebind_requests(owner).await.unwrap()).unwrap();
        assert!(!exposed.contains(&token));
        assert!(!exposed.contains(&super::super::device_access_tokens::token_hash(&token)));
        assert!(exposed.contains(&old.to_string()));
        assert!(exposed.contains(&id.to_string()));
        sqlx::query(
            "UPDATE device_access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(token_id)
        .execute(&db.db)
        .await
        .unwrap();
        assert!(
            db.authenticate_device_access_token(&token, record(Uuid::new_v4()))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM device_rebind_requests")
                .fetch_one(&db.db)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn existing_target_and_orphan_configuration_are_never_overwritten() {
        for conflict in ["device", "config", "revision", "token"] {
            let (db, owner, token, _, old, new) = fixture().await;
            let id = request(&db, owner, &token, new).await;
            match conflict {
                "device" => db
                    .upsert_device_heartbeat(DeviceHeartbeatRecord {
                        user_id: owner,
                        ..record(new)
                    })
                    .await
                    .unwrap(),
                "config" => {
                    sqlx::query("INSERT INTO user_running_network_configs (user_id,device_id,network_instance_id,network_config,source,disabled,create_time,update_time) VALUES (?,?,?,'{}','user',0,?,?)").bind(owner).bind(new.to_string()).bind(Uuid::new_v4().to_string()).bind(now_string()).bind(now_string()).execute(&db.db).await.unwrap();
                }
                "revision" => db
                    .set_managed_config_revision((owner, new), "existing-revision")
                    .await
                    .unwrap(),
                "token" => {
                    db.create_device_access_token(owner, "new independent token", Some(new), None)
                        .await
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(matches!(
                db.approve_device_rebind_request(owner, id).await,
                Err(DeviceRebindError::Conflict(_))
            ));
            assert!(
                db.resolve_device_access_token(&token, old)
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                db.resolve_device_access_token(&token, new)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                db.list_device_rebind_requests(owner).await.unwrap().len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn approval_is_single_use_and_storage_failure_rolls_back_the_entire_rebind() {
        let (db, owner, token, _, old, new) = fixture().await;
        let id = request(&db, owner, &token, new).await;
        db.set_managed_config_revision((owner, old), "kept")
            .await
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_test_rebind BEFORE UPDATE ON managed_config_revisions BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END")
            .execute(&db.db).await.unwrap();
        assert!(matches!(
            db.approve_device_rebind_request(owner, id).await,
            Err(DeviceRebindError::Database(_))
        ));
        assert!(db.get_device((owner, old)).await.unwrap().is_some());
        assert!(db.get_device((owner, new)).await.unwrap().is_none());
        assert_eq!(
            db.resolve_device_access_token(&token, old)
                .await
                .unwrap()
                .unwrap()
                .auth_generation,
            1
        );
        assert_eq!(
            db.get_managed_config_revision((owner, old))
                .await
                .unwrap()
                .as_deref(),
            Some("kept")
        );
        assert!(db.has_pending_device_rebind(&token, new).await.unwrap());
        sqlx::query("DROP TRIGGER reject_test_rebind")
            .execute(&db.db)
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            db.approve_device_rebind_request(owner, id),
            db.approve_device_rebind_request(owner, id)
        );
        assert_ne!(a.is_ok(), b.is_ok());
        assert_eq!(
            db.resolve_device_access_token(&token, new)
                .await
                .unwrap()
                .unwrap()
                .auth_generation,
            2
        );
    }

    #[tokio::test]
    async fn approval_supersedes_other_candidates_without_touching_another_owner() {
        let (db, owner, token, _, old, new) = fixture().await;
        let other = db
            .auto_create_user("another-recovery-owner")
            .await
            .unwrap()
            .id;
        let other_issued = db
            .create_device_access_token(other, "independent phone", None, None)
            .await
            .unwrap();
        assert!(
            db.authenticate_device_access_token(&other_issued.token, record(new))
                .await
                .unwrap()
                .is_some()
        );
        let alternate = Uuid::new_v4();
        let id = request(&db, owner, &token, new).await;
        let alternate_id = request(&db, owner, &token, alternate).await;
        db.approve_device_rebind_request(owner, id).await.unwrap();
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            db.approve_device_rebind_request(owner, alternate_id).await,
            Err(DeviceRebindError::Conflict(_))
        ));
        assert!(
            db.resolve_device_access_token(&token, old)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&token, alternate)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            db.resolve_device_access_token(&other_issued.token, new)
                .await
                .unwrap()
                .unwrap()
                .auth_generation,
            1
        );
        assert!(db.get_device((other, new)).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn expired_pending_and_rejected_requests_release_quota_without_reopening_active_rejections()
     {
        let (db, owner, token, _, _, first_candidate) = fixture().await;
        let first = request(&db, owner, &token, first_candidate).await;
        db.reject_device_rebind_request(owner, first).await.unwrap();
        for _ in 0..15 {
            request(&db, owner, &token, Uuid::new_v4()).await;
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=?"
            )
            .bind(owner)
            .fetch_one(&db.db)
            .await
            .unwrap(),
            16
        );
        let expired =
            (Utc::now() - chrono::Duration::days(8)).to_rfc3339_opts(SecondsFormat::Millis, true);
        sqlx::query("UPDATE device_rebind_requests SET last_seen_at=? WHERE user_id=?")
            .bind(expired)
            .bind(owner)
            .execute(&db.db)
            .await
            .unwrap();
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            !db.has_pending_device_rebind(&token, first_candidate)
                .await
                .unwrap()
        );
        let candidate = Uuid::new_v4();
        let id = request(&db, owner, &token, candidate).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=?"
            )
            .bind(owner)
            .fetch_one(&db.db)
            .await
            .unwrap(),
            1
        );
        db.reject_device_rebind_request(owner, id).await.unwrap();
        for _ in 0..3 {
            assert!(
                db.authenticate_device_access_token(&token, record(candidate))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            db.list_device_rebind_requests(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            !db.has_pending_device_rebind(&token, candidate)
                .await
                .unwrap()
        );
        let kept = sqlx::query(
            "SELECT status,attempt_count FROM device_rebind_requests WHERE user_id=? AND id=?",
        )
        .bind(owner)
        .bind(id.to_string())
        .fetch_one(&db.db)
        .await
        .unwrap();
        assert_eq!(kept.get::<String, _>("status"), "rejected");
        assert_eq!(kept.get::<i64, _>("attempt_count"), 4);
    }

    #[tokio::test]
    async fn request_queue_is_bounded_per_credential_and_retries_are_deduplicated() {
        let (db, owner, token, _, _, new) = fixture().await;
        let first = request(&db, owner, &token, new).await;
        for _ in 0..20 {
            assert!(
                db.authenticate_device_access_token(&token, record(new))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        let pending = db.list_device_rebind_requests(owner).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempt_count, 21);
        db.reject_device_rebind_request(owner, first).await.unwrap();
        for _ in 0..30 {
            assert!(
                db.authenticate_device_access_token(&token, record(Uuid::new_v4()))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM device_rebind_requests WHERE user_id=?"
            )
            .bind(owner)
            .fetch_one(&db.db)
            .await
            .unwrap(),
            16
        );
        assert_eq!(
            db.list_device_rebind_requests(owner).await.unwrap().len(),
            15
        );
    }
}
