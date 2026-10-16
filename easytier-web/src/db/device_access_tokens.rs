//! Device management credentials are independent from VPN network credentials.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::{RngCore as _, rngs::OsRng};
use sea_orm::DbErr;
use sha2::{Digest as _, Sha256};
use sqlx::{Row as _, sqlite::SqliteRow};
use uuid::Uuid;

use super::{Db, DeviceHeartbeatRecord, UserIdInDb, sqlx_db_error};

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct DeviceAccessTokenInfo {
    pub id: String,
    pub label: String,
    pub machine_id: Option<String>,
    pub created_at: String,
    pub bound_at: Option<String>,
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub status: String,
    pub auth_generation: u64,
}

#[derive(serde::Serialize)]
pub(crate) struct IssuedDeviceAccessToken {
    pub token: String,
    pub info: DeviceAccessTokenInfo,
    #[serde(skip)]
    pub retired_token_hash: Option<String>,
}

impl std::fmt::Debug for IssuedDeviceAccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedDeviceAccessToken")
            .field("info", &self.info)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceTokenIdentity {
    pub token_id: String,
    pub user_id: UserIdInDb,
    pub machine_id: Uuid,
    pub auth_generation: u64,
}

pub(crate) fn token_hash(token: &str) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(token.as_bytes()).iter() {
        write!(hex, "{byte:02x}").expect("writing to an owned String cannot fail");
    }
    hex
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn row_info(row: &SqliteRow) -> Result<DeviceAccessTokenInfo, DbErr> {
    let expires_at: Option<String> = row.try_get("expires_at").map_err(sqlx_db_error)?;
    let revoked_at: Option<String> = row.try_get("revoked_at").map_err(sqlx_db_error)?;
    let machine_id: Option<String> = row.try_get("machine_id").map_err(sqlx_db_error)?;
    let expired = expires_at.as_deref().is_some_and(|value| {
        DateTime::parse_from_rfc3339(value).map_or(true, |time| time <= Utc::now())
    });
    Ok(DeviceAccessTokenInfo {
        id: row.try_get("id").map_err(sqlx_db_error)?,
        label: row.try_get("label").map_err(sqlx_db_error)?,
        status: if revoked_at.is_some() {
            "revoked"
        } else if expired {
            "expired"
        } else if machine_id.is_some() {
            "active"
        } else {
            "pending"
        }
        .into(),
        machine_id,
        created_at: row.try_get("created_at").map_err(sqlx_db_error)?,
        bound_at: row.try_get("bound_at").map_err(sqlx_db_error)?,
        last_used_at: row.try_get("last_used_at").map_err(sqlx_db_error)?,
        expires_at,
        revoked_at,
        auth_generation: row
            .try_get::<i64, _>("auth_generation")
            .map_err(sqlx_db_error)? as u64,
    })
}

impl Db {
    pub(crate) async fn create_device_access_token(
        &self,
        user_id: UserIdInDb,
        label: &str,
        machine_id: Option<Uuid>,
        expires_in_seconds: Option<u64>,
    ) -> Result<IssuedDeviceAccessToken, DbErr> {
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 128 {
            return Err(DbErr::Custom(
                "invalid token label (1..128 characters required)".into(),
            ));
        }
        let expires_at = match expires_in_seconds {
            Some(seconds) if seconds == 0 || seconds > 10 * 365 * 24 * 3600 => {
                return Err(DbErr::Custom(
                    "invalid token lifetime (1 second to 10 years required)".into(),
                ));
            }
            Some(seconds) => Some(
                (Utc::now() + chrono::Duration::seconds(seconds as i64))
                    .to_rfc3339_opts(SecondsFormat::Millis, true),
            ),
            None => None,
        };
        let _guard = self.device_auth_gate.write().await;
        if let Some(machine_id) = machine_id {
            if self.is_device_blocked((user_id, machine_id)).await? {
                return Err(DbErr::Custom("device is blocked".into()));
            }
            if self
                .device_has_active_access_token(user_id, machine_id)
                .await?
            {
                return Err(DbErr::Custom(
                    "device already has an active access token; rotate it instead".into(),
                ));
            }
        }
        let token = new_token();
        let id = Uuid::new_v4().to_string();
        let now = now_string();
        sqlx::query("INSERT INTO device_access_tokens (id,user_id,label,token_hash,machine_id,created_at,bound_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
            .bind(&id).bind(user_id).bind(label).bind(token_hash(&token))
            .bind(machine_id.map(|id| id.to_string())).bind(&now)
            .bind(machine_id.map(|_| now.clone())).bind(expires_at)
            .execute(&self.db).await.map_err(sqlx_db_error)?;
        let info = self
            .get_device_access_token(user_id, &id)
            .await?
            .expect("inserted token");
        Ok(IssuedDeviceAccessToken {
            token,
            info,
            retired_token_hash: None,
        })
    }

    pub(crate) async fn get_device_access_token(
        &self,
        user_id: UserIdInDb,
        id: &str,
    ) -> Result<Option<DeviceAccessTokenInfo>, DbErr> {
        sqlx::query("SELECT * FROM device_access_tokens WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(&self.db)
            .await
            .map_err(sqlx_db_error)?
            .as_ref()
            .map(row_info)
            .transpose()
    }

    pub(crate) async fn list_device_access_tokens(
        &self,
        user_id: UserIdInDb,
    ) -> Result<Vec<DeviceAccessTokenInfo>, DbErr> {
        sqlx::query(
            "SELECT * FROM device_access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC,id",
        )
        .bind(user_id)
        .fetch_all(&self.db)
        .await
        .map_err(sqlx_db_error)?
        .iter()
        .map(row_info)
        .collect()
    }

    /// Internal retirement snapshot. Public lists hide revoked credentials,
    /// but workers still need their IDs and generations until disconnection.
    pub(crate) async fn list_revoked_device_access_tokens_for_machine(
        &self,
        user_id: UserIdInDb,
        machine_id: Uuid,
    ) -> Result<Vec<DeviceAccessTokenInfo>, DbErr> {
        sqlx::query(
            "SELECT * FROM device_access_tokens WHERE user_id=? AND machine_id=? AND revoked_at IS NOT NULL ORDER BY created_at DESC,id",
        )
        .bind(user_id)
        .bind(machine_id.to_string())
        .fetch_all(&self.db)
        .await
        .map_err(sqlx_db_error)?
        .iter()
        .map(row_info)
        .collect()
    }

    pub(crate) async fn rotate_device_access_token(
        &self,
        user_id: UserIdInDb,
        id: &str,
    ) -> Result<Option<IssuedDeviceAccessToken>, DbErr> {
        let _guard = self.device_auth_gate.write().await;
        let token = new_token();
        let old_hash = self.device_access_token_hash(user_id, id).await?;
        let changed = sqlx::query("UPDATE device_access_tokens SET token_hash = ?, auth_generation = auth_generation + 1 WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
            .bind(token_hash(&token)).bind(id).bind(user_id).bind(now_string())
            .execute(&self.db).await.map_err(sqlx_db_error)?.rows_affected();
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(IssuedDeviceAccessToken {
            token,
            info: self
                .get_device_access_token(user_id, id)
                .await?
                .expect("rotated token"),
            retired_token_hash: old_hash,
        }))
    }

    pub(crate) async fn revoke_device_access_token(
        &self,
        user_id: UserIdInDb,
        id: &str,
    ) -> Result<Option<DeviceAccessTokenInfo>, DbErr> {
        let _guard = self.device_auth_gate.write().await;
        sqlx::query("UPDATE device_access_tokens SET revoked_at = ?, auth_generation = auth_generation + 1 WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
            .bind(now_string()).bind(id).bind(user_id).execute(&self.db).await.map_err(sqlx_db_error)?;
        self.get_device_access_token(user_id, id).await
    }

    /// Called only after every session using this revoked credential has been
    /// retired. Keeping the tombstone until then preserves the token hash and
    /// generation needed to fence authentication and disconnect pending peers.
    pub(crate) async fn delete_revoked_device_access_token(
        &self,
        user_id: UserIdInDb,
        id: &str,
    ) -> Result<bool, DbErr> {
        let _guard = self.device_auth_gate.write().await;
        let deleted = sqlx::query(
            "DELETE FROM device_access_tokens WHERE user_id=? AND id=? AND revoked_at IS NOT NULL",
        )
        .bind(user_id)
        .bind(id)
        .execute(&self.db)
        .await
        .map_err(sqlx_db_error)?
        .rows_affected();
        Ok(deleted > 0)
    }

    /// Deletes the immutable revoked records captured by one device-retirement
    /// operation. A new credential revoked concurrently must keep its metadata
    /// until its own disconnect finishes, even when it belongs to this machine.
    pub(crate) async fn delete_revoked_device_access_tokens(
        &self,
        user_id: UserIdInDb,
        machine_id: Uuid,
        disconnected_token_ids: &[String],
    ) -> Result<u64, DbErr> {
        if disconnected_token_ids.is_empty() {
            return Ok(0);
        }
        let _guard = self.device_auth_gate.write().await;
        let mut deleted = 0;
        // Keep parameter counts bounded on older SQLite builds as well.
        for chunk in disconnected_token_ids.chunks(256) {
            let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "DELETE FROM device_access_tokens WHERE revoked_at IS NOT NULL AND user_id=",
            );
            query
                .push_bind(user_id)
                .push(" AND machine_id=")
                .push_bind(machine_id.to_string())
                .push(" AND id IN (");
            let mut ids = query.separated(",");
            for id in chunk {
                ids.push_bind(id);
            }
            ids.push_unseparated(")");
            deleted += query
                .build()
                .execute(&self.db)
                .await
                .map_err(sqlx_db_error)?
                .rows_affected();
        }
        Ok(deleted)
    }

    pub(crate) async fn revoke_all_device_access_tokens(
        &self,
        user_id: UserIdInDb,
        machine_id: Uuid,
    ) -> Result<Vec<DeviceAccessTokenInfo>, DbErr> {
        let _guard = self.device_auth_gate.write().await;
        sqlx::query("UPDATE device_access_tokens SET revoked_at=?,auth_generation=auth_generation+1 WHERE user_id=? AND machine_id=? AND revoked_at IS NULL")
            .bind(now_string()).bind(user_id).bind(machine_id.to_string()).execute(&self.db).await.map_err(sqlx_db_error)?;
        self.list_revoked_device_access_tokens_for_machine(user_id, machine_id)
            .await
    }

    pub(crate) async fn device_access_token_hash(
        &self,
        user_id: UserIdInDb,
        id: &str,
    ) -> Result<Option<String>, DbErr> {
        sqlx::query_scalar("SELECT token_hash FROM device_access_tokens WHERE user_id=? AND id=?")
            .bind(user_id)
            .bind(id)
            .fetch_optional(&self.db)
            .await
            .map_err(sqlx_db_error)
    }

    pub(crate) async fn device_has_active_access_token(
        &self,
        user_id: UserIdInDb,
        machine_id: Uuid,
    ) -> Result<bool, DbErr> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_access_tokens WHERE user_id=? AND machine_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)")
            .bind(user_id).bind(machine_id.to_string()).bind(now_string()).fetch_one(&self.db).await.map_err(sqlx_db_error)?;
        Ok(count > 0)
    }

    /// Non-mutating identity resolution. Never treats an unknown token as a username.
    pub(crate) async fn resolve_device_access_token(
        &self,
        token: &str,
        machine_id: Uuid,
    ) -> Result<Option<DeviceTokenIdentity>, DbErr> {
        let row = sqlx::query("SELECT t.id,t.user_id,t.auth_generation FROM device_access_tokens t WHERE t.token_hash = ? AND t.machine_id = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND NOT EXISTS (SELECT 1 FROM blocked_devices b WHERE b.user_id=t.user_id AND b.machine_id=t.machine_id)")
            .bind(token_hash(token)).bind(machine_id.to_string()).bind(now_string())
            .fetch_optional(&self.db).await.map_err(sqlx_db_error)?;
        row.map(|row| {
            Ok(DeviceTokenIdentity {
                token_id: row.try_get("id").map_err(sqlx_db_error)?,
                user_id: row.try_get("user_id").map_err(sqlx_db_error)?,
                machine_id,
                auth_generation: row
                    .try_get::<i64, _>("auth_generation")
                    .map_err(sqlx_db_error)? as u64,
            })
        })
        .transpose()
    }

    /// SQLite write transaction serializes first-use binding, block checks and registration.
    pub(crate) async fn authenticate_device_access_token(
        &self,
        token: &str,
        record: DeviceHeartbeatRecord,
    ) -> Result<Option<DeviceTokenIdentity>, DbErr> {
        let _guard = self.device_auth_gate.read().await;
        let mut transaction = self
            .db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(sqlx_db_error)?;
        let now = now_string();
        let machine_id = record.machine_id.to_string();
        let row = sqlx::query("SELECT * FROM device_access_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
            .bind(token_hash(token)).bind(&now).fetch_optional(&mut *transaction).await.map_err(sqlx_db_error)?;
        let Some(row) = row else {
            transaction.commit().await.map_err(sqlx_db_error)?;
            return Ok(None);
        };
        let owner: UserIdInDb = row.try_get("user_id").map_err(sqlx_db_error)?;
        let id: String = row.try_get("id").map_err(sqlx_db_error)?;
        let bound: Option<String> = row.try_get("machine_id").map_err(sqlx_db_error)?;
        if let Some(old_machine_id) = bound.as_deref().filter(|bound| *bound != machine_id) {
            super::device_rebind_requests::record_mismatch(
                &mut transaction,
                owner,
                &id,
                row.try_get("auth_generation").map_err(sqlx_db_error)?,
                old_machine_id,
                &record,
            )
            .await?;
            transaction.commit().await.map_err(sqlx_db_error)?;
            return Ok(None);
        }
        let already_bound: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_access_tokens WHERE user_id=? AND machine_id=? AND id<>? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)")
            .bind(owner).bind(&machine_id).bind(&id).bind(&now).fetch_one(&mut *transaction).await.map_err(sqlx_db_error)?;
        if already_bound > 0 {
            transaction.commit().await.map_err(sqlx_db_error)?;
            return Ok(None);
        }
        let blocked = sqlx::query("UPDATE blocked_devices SET hostname=?,attempt_count=attempt_count+1,last_attempt_time=? WHERE user_id=? AND machine_id=?")
            .bind(&record.hostname).bind(&now).bind(owner).bind(&machine_id)
            .execute(&mut *transaction).await.map_err(sqlx_db_error)?.rows_affected() > 0;
        if blocked {
            transaction.commit().await.map_err(sqlx_db_error)?;
            return Ok(None);
        }
        sqlx::query("UPDATE device_access_tokens SET machine_id=?,bound_at=COALESCE(bound_at,?),last_used_at=? WHERE id=?")
            .bind(&machine_id).bind(&now).bind(&now).bind(&id)
            .execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        sqlx::query("INSERT INTO devices (user_id,machine_id,hostname,easytier_version,device_os,client_url,first_seen_time,last_seen_time) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,machine_id) DO UPDATE SET hostname=excluded.hostname,easytier_version=excluded.easytier_version,device_os=excluded.device_os,last_seen_time=excluded.last_seen_time")
            .bind(owner).bind(&machine_id).bind(record.hostname).bind(record.easytier_version)
            .bind(record.device_os).bind(record.client_url).bind(&now).bind(&now)
            .execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        let identity = DeviceTokenIdentity {
            token_id: id,
            user_id: owner,
            machine_id: record.machine_id,
            auth_generation: row
                .try_get::<i64, _>("auth_generation")
                .map_err(sqlx_db_error)? as u64,
        };
        transaction.commit().await.map_err(sqlx_db_error)?;
        Ok(Some(identity))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use easytier::{common::config::ConfigSource, proto::api::manage::NetworkConfig};
    use easytier_core::management::remote_client::Storage as _;
    fn record(machine_id: Uuid) -> DeviceHeartbeatRecord {
        DeviceHeartbeatRecord {
            user_id: 0,
            machine_id,
            hostname: "test-device".into(),
            easytier_version: "2.7".into(),
            device_os: "{}".into(),
            client_url: String::new(),
        }
    }

    #[tokio::test]
    async fn deleted_revoked_token_stays_invalid_and_preserves_device_configuration() {
        let db = Db::memory_db().await;
        let owner = db
            .auto_create_user("remove-revoked-owner")
            .await
            .unwrap()
            .id;
        let other = db
            .auto_create_user("remove-revoked-other")
            .await
            .unwrap()
            .id;
        let machine = Uuid::new_v4();
        let issued = db
            .create_device_access_token(owner, "remove", None, None)
            .await
            .unwrap();
        let identity = db
            .authenticate_device_access_token(&issued.token, record(machine))
            .await
            .unwrap()
            .unwrap();
        let network = Uuid::new_v4();
        db.insert_or_update_user_network_config(
            (owner, machine),
            network,
            NetworkConfig {
                network_name: Some("kept configuration".into()),
                ..Default::default()
            },
            ConfigSource::User,
        )
        .await
        .unwrap();
        assert!(
            !db.delete_revoked_device_access_token(owner, &issued.info.id)
                .await
                .unwrap(),
            "effective credentials cannot be deleted directly"
        );
        let revoked = db
            .revoke_device_access_token(owner, &issued.info.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revoked.auth_generation, identity.auth_generation + 1);
        assert!(
            db.list_device_access_tokens(owner)
                .await
                .unwrap()
                .is_empty(),
            "revoked credentials are hidden while pending sessions are retired"
        );
        assert!(
            db.device_access_token_hash(owner, &issued.info.id)
                .await
                .unwrap()
                .is_some(),
            "retirement still has the digest needed to disconnect pending sessions"
        );
        assert!(
            !db.delete_revoked_device_access_token(other, &issued.info.id)
                .await
                .unwrap()
        );
        assert!(
            db.get_device_access_token(owner, &issued.info.id)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            db.delete_revoked_device_access_token(owner, &issued.info.id)
                .await
                .unwrap()
        );
        assert!(
            !db.delete_revoked_device_access_token(owner, &issued.info.id)
                .await
                .unwrap()
        );
        assert!(
            db.list_device_access_tokens(owner)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            db.device_access_token_hash(owner, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&issued.token, machine)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.authenticate_device_access_token(&issued.token, record(machine))
                .await
                .unwrap()
                .is_none()
        );
        assert!(db.get_device((owner, machine)).await.unwrap().is_some());
        assert!(
            db.get_network_config((owner, machine), &network.to_string())
                .await
                .unwrap()
                .is_some()
        );
        // Rotation remains an update to the one effective credential, not a
        // deletion or historical row left behind by this cleanup.
        let other_token = db
            .create_device_access_token(other, "other", None, None)
            .await
            .unwrap();
        let rotated = db
            .rotate_device_access_token(other, &other_token.info.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rotated.info.id, other_token.info.id);
        assert_eq!(rotated.info.auth_generation, 2);
        assert_eq!(db.list_device_access_tokens(other).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn revoke_all_captures_revoked_machine_ids_without_exposing_them_in_public_lists() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("capture-owner").await.unwrap().id;
        let other = db.auto_create_user("capture-other").await.unwrap().id;
        let machine = Uuid::new_v4();
        let elsewhere = Uuid::new_v4();
        let already_revoked = db
            .create_device_access_token(owner, "pending retirement", Some(machine), None)
            .await
            .unwrap();
        db.revoke_device_access_token(owner, &already_revoked.info.id)
            .await
            .unwrap();
        let active = db
            .create_device_access_token(owner, "current credential", Some(machine), None)
            .await
            .unwrap();
        let other_machine = db
            .create_device_access_token(owner, "other machine", Some(elsewhere), None)
            .await
            .unwrap();
        let other_owner = db
            .create_device_access_token(other, "other owner", Some(machine), None)
            .await
            .unwrap();

        let captured = db
            .revoke_all_device_access_tokens(owner, machine)
            .await
            .unwrap();
        let mut actual_ids = captured
            .iter()
            .map(|token| token.id.clone())
            .collect::<Vec<_>>();
        actual_ids.sort();
        let mut expected_ids = vec![already_revoked.info.id.clone(), active.info.id.clone()];
        expected_ids.sort();
        assert_eq!(actual_ids, expected_ids);
        assert!(captured.iter().all(|token| token.revoked_at.is_some()));
        assert_eq!(
            captured
                .iter()
                .find(|token| token.id == active.info.id)
                .unwrap()
                .auth_generation,
            active.info.auth_generation + 1
        );
        let listed = db.list_device_access_tokens(owner).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, other_machine.info.id);
        assert!(
            db.device_access_token_hash(owner, &active.info.id)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            db.resolve_device_access_token(&active.token, machine)
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
            db.resolve_device_access_token(&other_owner.token, machine)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn bulk_revoked_cleanup_only_deletes_the_disconnected_owner_machine_snapshot() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("bulk-cleanup-owner").await.unwrap().id;
        let other = db.auto_create_user("bulk-cleanup-other").await.unwrap().id;
        let machine = Uuid::new_v4();
        let elsewhere = Uuid::new_v4();
        let first = db
            .create_device_access_token(owner, "disconnected", Some(machine), None)
            .await
            .unwrap();
        db.revoke_device_access_token(owner, &first.info.id)
            .await
            .unwrap();
        // A credential revoked after the caller captured its disconnect list
        // must not lose its digest before that independent retirement finishes.
        let late = db
            .create_device_access_token(owner, "late revoke", Some(machine), None)
            .await
            .unwrap();
        db.revoke_device_access_token(owner, &late.info.id)
            .await
            .unwrap();
        let active = db
            .create_device_access_token(owner, "new active", Some(machine), None)
            .await
            .unwrap();
        let other_machine = db
            .create_device_access_token(owner, "other machine", Some(elsewhere), None)
            .await
            .unwrap();
        db.revoke_device_access_token(owner, &other_machine.info.id)
            .await
            .unwrap();
        let other_owner = db
            .create_device_access_token(other, "other owner", Some(machine), None)
            .await
            .unwrap();
        db.revoke_device_access_token(other, &other_owner.info.id)
            .await
            .unwrap();
        let ids = vec![
            first.info.id.clone(),
            active.info.id.clone(),
            other_machine.info.id.clone(),
            other_owner.info.id.clone(),
        ];
        assert_eq!(
            db.delete_revoked_device_access_tokens(owner, machine, &ids)
                .await
                .unwrap(),
            1
        );
        assert!(
            db.get_device_access_token(owner, &first.info.id)
                .await
                .unwrap()
                .is_none()
        );
        for (id, token_owner) in [
            (&late.info.id, owner),
            (&active.info.id, owner),
            (&other_machine.info.id, owner),
            (&other_owner.info.id, other),
        ] {
            assert!(
                db.get_device_access_token(token_owner, id)
                    .await
                    .unwrap()
                    .is_some()
            );
        }
        assert_eq!(
            db.delete_revoked_device_access_tokens(owner, machine, &[late.info.id])
                .await
                .unwrap(),
            1
        );
        assert!(
            db.resolve_device_access_token(&late.token, machine)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&active.token, machine)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            db.delete_revoked_device_access_tokens(owner, machine, &[])
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn a_device_has_only_one_effective_management_credential() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("single-token-owner").await.unwrap().id;
        let machine_id = Uuid::new_v4();
        let first = db
            .create_device_access_token(owner, "first", None, None)
            .await
            .unwrap();
        let second = db
            .create_device_access_token(owner, "second", None, None)
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            db.authenticate_device_access_token(&first.token, record(machine_id)),
            db.authenticate_device_access_token(&second.token, record(machine_id))
        );
        assert_ne!(a.unwrap().is_some(), b.unwrap().is_some());
        assert!(
            db.create_device_access_token(owner, "prebound", Some(machine_id), None)
                .await
                .is_err()
        );
        db.revoke_all_device_access_tokens(owner, machine_id)
            .await
            .unwrap();
        let new = db
            .create_device_access_token(owner, "replacement", Some(machine_id), None)
            .await
            .unwrap();
        assert!(
            db.authenticate_device_access_token(&new.token, record(machine_id))
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn first_bind_is_atomic_and_owner_scoped_and_rotation_revokes_old_secret() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("token-owner").await.unwrap().id;
        let other = db.auto_create_user("other-owner").await.unwrap().id;
        let issued = db
            .create_device_access_token(owner, "phone", None, None)
            .await
            .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&issued.token).unwrap().len(), 32);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let (auth_a, auth_b) = tokio::join!(
            db.authenticate_device_access_token(&issued.token, record(a)),
            db.authenticate_device_access_token(&issued.token, record(b))
        );
        let (auth_a, auth_b) = (auth_a.unwrap(), auth_b.unwrap());
        assert_ne!(auth_a.is_some(), auth_b.is_some());
        let winner = auth_a.or(auth_b).unwrap();
        assert_eq!(winner.user_id, owner);
        assert!(
            db.authenticate_device_access_token(&issued.token, record(winner.machine_id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            db.get_device_access_token(other, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.rotate_device_access_token(other, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.revoke_device_access_token(other, &issued.info.id)
                .await
                .unwrap()
                .is_none()
        );
        let raw: String =
            sqlx::query_scalar("SELECT token_hash FROM device_access_tokens WHERE id=?")
                .bind(&issued.info.id)
                .fetch_one(&db.db)
                .await
                .unwrap();
        assert_eq!(raw, token_hash(&issued.token));
        assert_ne!(raw, issued.token);
        assert!(!format!("{issued:?}").contains(&issued.token));
        assert!(
            !serde_json::to_string(&db.list_device_access_tokens(owner).await.unwrap())
                .unwrap()
                .contains(&issued.token)
        );
        let rotated = db
            .rotate_device_access_token(owner, &issued.info.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rotated.info.machine_id, Some(winner.machine_id.to_string()));
        assert_eq!(rotated.info.auth_generation, winner.auth_generation + 1);
        assert!(
            db.resolve_device_access_token(&issued.token, winner.machine_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&rotated.token, winner.machine_id)
                .await
                .unwrap()
                .is_some()
        );
        db.revoke_device_access_token(owner, &issued.info.id)
            .await
            .unwrap();
        assert!(
            db.resolve_device_access_token(&rotated.token, winner.machine_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn unknown_username_expired_and_blocked_tokens_cannot_enroll() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("owner").await.unwrap().id;
        let machine = Uuid::new_v4();
        assert!(
            db.authenticate_device_access_token("owner", record(machine))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.authenticate_device_access_token("unknown", record(machine))
                .await
                .unwrap()
                .is_none()
        );
        assert!(db.get_user_id("unknown").await.unwrap().is_none());
        let token = db
            .create_device_access_token(owner, "short", None, Some(1))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE device_access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(&token.info.id)
        .execute(&db.db)
        .await
        .unwrap();
        assert!(
            db.authenticate_device_access_token(&token.token, record(machine))
                .await
                .unwrap()
                .is_none()
        );
        let token = db
            .create_device_access_token(owner, "blocked", None, None)
            .await
            .unwrap();
        assert!(
            db.authenticate_device_access_token(&token.token, record(machine))
                .await
                .unwrap()
                .is_some()
        );
        db.delete_device_with_optional_block((owner, machine), true)
            .await
            .unwrap();
        assert!(
            db.authenticate_device_access_token(&token.token, record(machine))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.resolve_device_access_token(&token.token, machine)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn token_binding_and_generation_survive_database_reopen() {
        let path = std::env::temp_dir().join(format!("easytier-token-test-{}.db", Uuid::new_v4()));
        let db = Db::new(path.to_string_lossy()).await.unwrap();
        let owner = db.auto_create_user("persist-owner").await.unwrap().id;
        let machine = Uuid::new_v4();
        let issued = db
            .create_device_access_token(owner, "persistent", None, None)
            .await
            .unwrap();
        db.authenticate_device_access_token(&issued.token, record(machine))
            .await
            .unwrap()
            .unwrap();
        let rotated = db
            .rotate_device_access_token(owner, &issued.info.id)
            .await
            .unwrap()
            .unwrap();
        db.inner().close().await;
        drop(db);
        let db = Db::new(path.to_string_lossy()).await.unwrap();
        assert!(
            db.resolve_device_access_token(&issued.token, machine)
                .await
                .unwrap()
                .is_none()
        );
        let identity = db
            .resolve_device_access_token(&rotated.token, machine)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(identity.user_id, owner);
        assert_eq!(identity.auth_generation, 2);
        db.inner().close().await;
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
