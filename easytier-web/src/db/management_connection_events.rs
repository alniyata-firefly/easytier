//! Tenant-scoped categorical management events. Never accepts free-form errors
//! or configuration material, even from an authenticated client.
use std::{collections::BTreeMap, net::IpAddr, sync::OnceLock};

use chrono::Utc;
use sea_orm::DbErr;
use sqlx::{Row as _, Sqlite, Transaction};
use uuid::Uuid;

use super::{Db, UserIdInDb, sqlx_db_error};

const RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
const OWNER_EVENT_LIMIT: i64 = 10_000;
const OWNER_STATE_LIMIT: i64 = 10_000;

fn server_epoch() -> &'static str {
    static EPOCH: OnceLock<String> = OnceLock::new();
    EPOCH.get_or_init(|| Uuid::new_v4().to_string())
}

#[derive(Clone, Copy)]
pub(crate) enum ManagementConnectionEventKind {
    Authorized,
    Disconnected,
    AuthorizationLost,
    IdentityRejected,
    PendingApproval,
}

impl ManagementConnectionEventKind {
    fn codes(self) -> (&'static str, &'static str) {
        match self {
            Self::Authorized => ("authorized", "authorization_granted"),
            Self::Disconnected => ("disconnected", "connection_closed"),
            Self::AuthorizationLost => ("authentication_rejected", "authorization_lost"),
            Self::IdentityRejected => ("authentication_rejected", "device_identity_mismatch"),
            Self::PendingApproval => ("pending_approval", "device_rebind_required"),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ManagementFailureReason {
    NodeReported,
    ConfigurationRpc,
}

impl ManagementFailureReason {
    fn code(self) -> &'static str {
        match self {
            Self::NodeReported => "node_reported_failure",
            Self::ConfigurationRpc => "configuration_rpc_failed",
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ManagementConnectionEventInfo {
    pub id: i64,
    pub device_id: String,
    pub event: String,
    pub reason: String,
    /// UTC Unix seconds.
    pub occurred_at: i64,
    pub peer_ip: Option<String>,
    pub instance_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct ManagementConnectionEventPage {
    pub events: Vec<ManagementConnectionEventInfo>,
    pub next_before_id: Option<i64>,
}

fn safe_peer_ip(peer: Option<&str>) -> Option<String> {
    peer?
        .trim_matches(|c| c == '[' || c == ']')
        .parse::<IpAddr>()
        .ok()
        .map(|ip| ip.to_string())
}

async fn prune(
    transaction: &mut Transaction<'_, Sqlite>,
    owner: UserIdInDb,
    now: i64,
) -> Result<(), DbErr> {
    sqlx::query("DELETE FROM management_connection_events WHERE occurred_at<?")
        .bind(now - RETENTION_SECONDS)
        .execute(&mut **transaction)
        .await
        .map_err(sqlx_db_error)?;
    sqlx::query("DELETE FROM management_connection_events WHERE user_id=? AND id IN (SELECT id FROM management_connection_events WHERE user_id=? ORDER BY id DESC LIMIT -1 OFFSET ?)")
        .bind(owner).bind(owner).bind(OWNER_EVENT_LIMIT).execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    sqlx::query("DELETE FROM management_connection_event_states WHERE updated_at<?")
        .bind(now - RETENTION_SECONDS)
        .execute(&mut **transaction)
        .await
        .map_err(sqlx_db_error)?;
    sqlx::query("DELETE FROM management_connection_event_states WHERE rowid IN (SELECT rowid FROM management_connection_event_states WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ?)")
        .bind(owner).bind(OWNER_STATE_LIMIT).execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    Ok(())
}

async fn transition(
    transaction: &mut Transaction<'_, Sqlite>,
    owner: UserIdInDb,
    device: Uuid,
    category: &str,
    instance: Option<Uuid>,
    event: &str,
    reason: &str,
    peer_ip: Option<&str>,
    epoch: Option<i64>,
    now: i64,
) -> Result<bool, DbErr> {
    let instance = instance.map(|value| value.to_string()).unwrap_or_default();
    let device = device.to_string();
    let previous = sqlx::query("SELECT event,reason,server_epoch,session_epoch FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category=? AND instance_id=?")
        .bind(owner).bind(&device).bind(category).bind(&instance)
        .fetch_optional(&mut **transaction).await.map_err(sqlx_db_error)?;
    if let Some(previous) = previous.as_ref() {
        let previous_epoch: Option<i64> =
            previous.try_get("session_epoch").map_err(sqlx_db_error)?;
        if previous
            .try_get::<String, _>("server_epoch")
            .map_err(sqlx_db_error)?
            == server_epoch()
            && epoch
                .zip(previous_epoch)
                .is_some_and(|(current, previous)| current < previous)
        {
            return Ok(false);
        }
        if category == "connection"
            && event == "authorized"
            && epoch.is_some()
            && epoch == previous_epoch
            && previous
                .try_get::<String, _>("server_epoch")
                .map_err(sqlx_db_error)?
                == server_epoch()
            && matches!(
                previous
                    .try_get::<String, _>("event")
                    .map_err(sqlx_db_error)?
                    .as_str(),
                "disconnected" | "authentication_rejected"
            )
        {
            // This session cannot authorize again after becoming invalid.
            // A delayed diagnostic write must not reopen its terminal state.
            return Ok(false);
        }
    }
    let changed = previous
        .as_ref()
        .map(|row| -> Result<bool, DbErr> {
            Ok(
                row.try_get::<String, _>("event").map_err(sqlx_db_error)? != event
                    || row.try_get::<String, _>("reason").map_err(sqlx_db_error)? != reason
                    || (event == "authorized"
                        && (row
                            .try_get::<String, _>("server_epoch")
                            .map_err(sqlx_db_error)?
                            != server_epoch()
                            || row
                                .try_get::<Option<i64>, _>("session_epoch")
                                .map_err(sqlx_db_error)?
                                != epoch)),
            )
        })
        .transpose()?
        .unwrap_or(true);
    sqlx::query("INSERT INTO management_connection_event_states(user_id,device_id,category,instance_id,event,reason,server_epoch,session_epoch,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,device_id,category,instance_id) DO UPDATE SET event=excluded.event,reason=excluded.reason,server_epoch=excluded.server_epoch,session_epoch=excluded.session_epoch,updated_at=excluded.updated_at")
        .bind(owner).bind(&device).bind(category).bind(&instance).bind(event).bind(reason).bind(server_epoch()).bind(epoch).bind(now)
        .execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    if changed {
        sqlx::query("INSERT INTO management_connection_events(user_id,device_id,event,reason,occurred_at,peer_ip,instance_id) VALUES(?,?,?,?,?,?,?)")
            .bind(owner).bind(&device).bind(event).bind(reason).bind(now).bind(safe_peer_ip(peer_ip))
            .bind((!instance.is_empty()).then_some(instance)).execute(&mut **transaction).await.map_err(sqlx_db_error)?;
    }
    Ok(changed)
}

impl Db {
    pub(crate) async fn record_management_connection_event(
        &self,
        owner: UserIdInDb,
        device: Uuid,
        kind: ManagementConnectionEventKind,
        peer_ip: Option<&str>,
        session_epoch: Option<u64>,
    ) -> Result<(), DbErr> {
        let now = Utc::now().timestamp();
        let epoch = session_epoch
            .map(i64::try_from)
            .transpose()
            .map_err(|_| DbErr::Custom("invalid event session epoch".into()))?;
        let mut transaction = self
            .db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(sqlx_db_error)?;
        let (event, reason) = kind.codes();
        let changed = transition(
            &mut transaction,
            owner,
            device,
            "connection",
            None,
            event,
            reason,
            peer_ip,
            epoch,
            now,
        )
        .await?;
        if event == "authorized" && changed {
            sqlx::query("DELETE FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category='authentication_attempt'")
                .bind(owner).bind(device.to_string()).execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        }
        prune(&mut transaction, owner, now).await?;
        transaction.commit().await.map_err(sqlx_db_error)
    }

    /// Only an effective credential proves ownership for an unauthenticated
    /// attempt. Unknown/expired/revoked secrets never create tenant events.
    pub(crate) async fn record_management_auth_rejection(
        &self,
        token: &str,
        device: Uuid,
        pending: bool,
        peer_ip: Option<&str>,
    ) -> Result<(), DbErr> {
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let row = sqlx::query("SELECT user_id,machine_id FROM device_access_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)")
            .bind(super::device_access_token_hash(token)).bind(now).fetch_optional(&self.db).await.map_err(sqlx_db_error)?;
        let Some(row) = row else {
            return Ok(());
        };
        let owner = row.try_get("user_id").map_err(sqlx_db_error)?;
        let bound: Option<String> = row.try_get("machine_id").map_err(sqlx_db_error)?;
        let kind = if pending {
            ManagementConnectionEventKind::PendingApproval
        } else if bound
            .as_deref()
            .is_some_and(|bound| bound != device.to_string())
        {
            ManagementConnectionEventKind::IdentityRejected
        } else {
            ManagementConnectionEventKind::AuthorizationLost
        };
        let now = Utc::now().timestamp();
        let mut transaction = self
            .db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(sqlx_db_error)?;
        let (event, reason) = kind.codes();
        transition(
            &mut transaction,
            owner,
            device,
            "authentication_attempt",
            None,
            event,
            reason,
            peer_ip,
            None,
            now,
        )
        .await?;
        prune(&mut transaction, owner, now).await?;
        transaction.commit().await.map_err(sqlx_db_error)
    }

    /// Receives the complete bounded failure snapshot, so recovery silently
    /// clears the state and a later failure can produce a fresh event.
    pub(crate) async fn sync_management_config_failures(
        &self,
        owner: UserIdInDb,
        device: Uuid,
        failures: &[(Uuid, ManagementFailureReason)],
        peer_ip: Option<&str>,
        session_epoch: u64,
        snapshot_revision: u64,
    ) -> Result<(), DbErr> {
        let now = Utc::now().timestamp();
        let epoch = i64::try_from(session_epoch)
            .map_err(|_| DbErr::Custom("invalid event session epoch".into()))?;
        let revision = i64::try_from(snapshot_revision)
            .map_err(|_| DbErr::Custom("invalid event snapshot revision".into()))?;
        let failures = failures
            .iter()
            .take(256)
            .map(|(id, reason)| (*id, reason.code()))
            .collect::<BTreeMap<_, _>>();
        let mut transaction = self
            .db
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(sqlx_db_error)?;
        // A delayed old session must not clear or write the new owner's state.
        let current = sqlx::query("SELECT event,server_epoch,session_epoch FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category='connection'")
            .bind(owner).bind(device.to_string()).fetch_optional(&mut *transaction).await.map_err(sqlx_db_error)?;
        if let Some(current) = current {
            if current
                .try_get::<String, _>("server_epoch")
                .map_err(sqlx_db_error)?
                == server_epoch()
                && current
                    .try_get::<Option<i64>, _>("session_epoch")
                    .map_err(sqlx_db_error)?
                    .is_some_and(|current| current > epoch)
            {
                return Ok(());
            }
            if current
                .try_get::<String, _>("server_epoch")
                .map_err(sqlx_db_error)?
                == server_epoch()
                && current
                    .try_get::<Option<i64>, _>("session_epoch")
                    .map_err(sqlx_db_error)?
                    == Some(epoch)
                && current
                    .try_get::<String, _>("event")
                    .map_err(sqlx_db_error)?
                    != "authorized"
            {
                return Ok(());
            }
        }
        let snapshot = sqlx::query("SELECT server_epoch,session_epoch,snapshot_revision FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category='configuration' AND instance_id=''")
            .bind(owner).bind(device.to_string()).fetch_optional(&mut *transaction).await.map_err(sqlx_db_error)?;
        if let Some(snapshot) = snapshot {
            let previous_epoch: Option<i64> =
                snapshot.try_get("session_epoch").map_err(sqlx_db_error)?;
            let previous_revision: i64 = snapshot
                .try_get("snapshot_revision")
                .map_err(sqlx_db_error)?;
            if snapshot
                .try_get::<String, _>("server_epoch")
                .map_err(sqlx_db_error)?
                == server_epoch()
                && previous_epoch.is_some_and(|previous| {
                    previous > epoch || (previous == epoch && previous_revision > revision)
                })
            {
                return Ok(());
            }
        }
        let previous = sqlx::query_scalar::<_,String>("SELECT instance_id FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category='configuration' AND instance_id<>''")
            .bind(owner).bind(device.to_string()).fetch_all(&mut *transaction).await.map_err(sqlx_db_error)?;
        for previous in previous {
            if Uuid::parse_str(&previous)
                .ok()
                .is_none_or(|id| !failures.contains_key(&id))
            {
                sqlx::query("DELETE FROM management_connection_event_states WHERE user_id=? AND device_id=? AND category='configuration' AND instance_id=?")
                    .bind(owner).bind(device.to_string()).bind(previous).execute(&mut *transaction).await.map_err(sqlx_db_error)?;
            }
        }
        for (instance, reason) in failures {
            transition(
                &mut transaction,
                owner,
                device,
                "configuration",
                Some(instance),
                "configuration_apply_failed",
                reason,
                peer_ip,
                Some(epoch),
                now,
            )
            .await?;
        }
        sqlx::query("INSERT INTO management_connection_event_states(user_id,device_id,category,instance_id,event,reason,server_epoch,session_epoch,snapshot_revision,updated_at) VALUES(?,?,'configuration','','snapshot','',?,?,?,?) ON CONFLICT(user_id,device_id,category,instance_id) DO UPDATE SET server_epoch=excluded.server_epoch,session_epoch=excluded.session_epoch,snapshot_revision=excluded.snapshot_revision,updated_at=excluded.updated_at")
            .bind(owner).bind(device.to_string()).bind(server_epoch()).bind(epoch).bind(revision).bind(now)
            .execute(&mut *transaction).await.map_err(sqlx_db_error)?;
        prune(&mut transaction, owner, now).await?;
        transaction.commit().await.map_err(sqlx_db_error)
    }

    pub(crate) async fn list_management_connection_events(
        &self,
        owner: UserIdInDb,
        device: Option<Uuid>,
        before_id: Option<i64>,
        limit: u32,
    ) -> Result<ManagementConnectionEventPage, DbErr> {
        let limit = limit.clamp(1, 200) as usize;
        let rows = sqlx::query("SELECT id,device_id,event,reason,occurred_at,peer_ip,instance_id FROM management_connection_events WHERE user_id=? AND occurred_at>=? AND (? IS NULL OR device_id=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?")
            .bind(owner).bind(Utc::now().timestamp()-RETENTION_SECONDS).bind(device.map(|id| id.to_string())).bind(device.map(|id| id.to_string()))
            .bind(before_id).bind(before_id).bind((limit+1) as i64).fetch_all(&self.db).await.map_err(sqlx_db_error)?;
        let more = rows.len() > limit;
        let events = rows
            .into_iter()
            .take(limit)
            .map(|row| -> Result<_, DbErr> {
                Ok(ManagementConnectionEventInfo {
                    id: row.try_get("id").map_err(sqlx_db_error)?,
                    device_id: row.try_get("device_id").map_err(sqlx_db_error)?,
                    event: row.try_get("event").map_err(sqlx_db_error)?,
                    reason: row.try_get("reason").map_err(sqlx_db_error)?,
                    occurred_at: row.try_get("occurred_at").map_err(sqlx_db_error)?,
                    peer_ip: row.try_get("peer_ip").map_err(sqlx_db_error)?,
                    instance_id: row.try_get("instance_id").map_err(sqlx_db_error)?,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let next_before_id = more.then(|| events.last().unwrap().id);
        Ok(ManagementConnectionEventPage {
            events,
            next_before_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn owner(db: &Db, name: &str) -> i32 {
        db.auto_create_user(name).await.unwrap().id
    }

    #[tokio::test]
    async fn connection_events_are_owner_scoped_paginated_and_session_fenced() {
        let db = Db::memory_db().await;
        let a = owner(&db, "event-owner-a").await;
        let b = owner(&db, "event-owner-b").await;
        let device = Uuid::new_v4();
        for epoch in [1, 1, 2] {
            db.record_management_connection_event(
                a,
                device,
                ManagementConnectionEventKind::Authorized,
                Some("2001:db8::1"),
                Some(epoch),
            )
            .await
            .unwrap();
        }
        db.record_management_connection_event(
            a,
            device,
            ManagementConnectionEventKind::Disconnected,
            None,
            Some(1),
        )
        .await
        .unwrap();
        assert_eq!(
            db.list_management_connection_events(a, None, None, 100)
                .await
                .unwrap()
                .events
                .len(),
            2
        );
        db.record_management_connection_event(
            a,
            device,
            ManagementConnectionEventKind::Disconnected,
            None,
            Some(2),
        )
        .await
        .unwrap();
        db.record_management_connection_event(
            b,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(10),
        )
        .await
        .unwrap();
        let first = db
            .list_management_connection_events(a, Some(device), None, 2)
            .await
            .unwrap();
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.events[0].event, "disconnected");
        let second = db
            .list_management_connection_events(a, Some(device), first.next_before_id, 2)
            .await
            .unwrap();
        assert_eq!(second.events.len(), 1);
        assert!(second.next_before_id.is_none());
        assert!(second.events[0].id < first.events[1].id);
        assert_eq!(
            db.list_management_connection_events(b, None, None, 100)
                .await
                .unwrap()
                .events
                .len(),
            1
        );
        assert!(
            db.list_management_connection_events(a, Some(Uuid::new_v4()), None, 100)
                .await
                .unwrap()
                .events
                .is_empty()
        );
    }

    #[tokio::test]
    async fn delayed_authorized_and_failure_writes_cannot_reopen_a_closed_session() {
        let db = Db::memory_db().await;
        let owner = owner(&db, "terminal-event-owner").await;
        let device = Uuid::new_v4();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Disconnected,
            None,
            Some(1),
        )
        .await
        .unwrap();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(1),
        )
        .await
        .unwrap();
        db.sync_management_config_failures(
            owner,
            device,
            &[(Uuid::new_v4(), ManagementFailureReason::NodeReported)],
            None,
            1,
            1,
        )
        .await
        .unwrap();
        let events = db
            .list_management_connection_events(owner, None, None, 100)
            .await
            .unwrap()
            .events;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "disconnected");
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(
            db.list_management_connection_events(owner, None, None, 100)
                .await
                .unwrap()
                .events[0]
                .event,
            "authorized"
        );
    }

    #[tokio::test]
    async fn failures_log_only_changes_and_stale_snapshots_cannot_undo_recovery() {
        let db = Db::memory_db().await;
        let owner = owner(&db, "failure-event-owner").await;
        let device = Uuid::new_v4();
        let instance = Uuid::new_v4();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(1),
        )
        .await
        .unwrap();
        for revision in [1, 2] {
            db.sync_management_config_failures(
                owner,
                device,
                &[(instance, ManagementFailureReason::NodeReported)],
                None,
                1,
                revision,
            )
            .await
            .unwrap();
        }
        db.sync_management_config_failures(
            owner,
            device,
            &[(instance, ManagementFailureReason::ConfigurationRpc)],
            None,
            1,
            3,
        )
        .await
        .unwrap();
        db.sync_management_config_failures(owner, device, &[], None, 1, 4)
            .await
            .unwrap();
        db.sync_management_config_failures(
            owner,
            device,
            &[(instance, ManagementFailureReason::NodeReported)],
            None,
            1,
            2,
        )
        .await
        .unwrap();
        let events = db
            .list_management_connection_events(owner, None, None, 100)
            .await
            .unwrap()
            .events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event == "configuration_apply_failed")
                .count(),
            2
        );
        db.sync_management_config_failures(
            owner,
            device,
            &[(instance, ManagementFailureReason::NodeReported)],
            None,
            1,
            5,
        )
        .await
        .unwrap();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(2),
        )
        .await
        .unwrap();
        db.sync_management_config_failures(owner, device, &[], None, 1, 99)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM management_connection_event_states WHERE user_id=? AND category='configuration' AND instance_id=?")
            .bind(owner).bind(instance.to_string()).fetch_one(&db.db).await.unwrap();
        assert_eq!(count, 1);
        let events = db
            .list_management_connection_events(owner, None, None, 100)
            .await
            .unwrap()
            .events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event == "configuration_apply_failed")
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn unknown_revoked_and_expired_tokens_cannot_attribute_rejections() {
        let db = Db::memory_db().await;
        let owner = owner(&db, "credential-event-owner").await;
        let device = Uuid::new_v4();
        db.record_management_auth_rejection(
            "unknown-secret",
            device,
            true,
            Some("credential-material"),
        )
        .await
        .unwrap();
        assert!(
            db.list_management_connection_events(owner, None, None, 100)
                .await
                .unwrap()
                .events
                .is_empty()
        );
        let token = db
            .create_device_access_token(owner, "test", None, None)
            .await
            .unwrap();
        for _ in 0..3 {
            db.record_management_auth_rejection(&token.token, device, true, Some("198.51.100.7"))
                .await
                .unwrap();
        }
        assert_eq!(
            db.list_management_connection_events(owner, None, None, 100)
                .await
                .unwrap()
                .events
                .len(),
            1
        );
        // Attempt state must not erase the newer live session's epoch fence.
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            None,
            Some(10),
        )
        .await
        .unwrap();
        db.record_management_auth_rejection(&token.token, device, false, None)
            .await
            .unwrap();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Disconnected,
            None,
            Some(9),
        )
        .await
        .unwrap();
        let events = db
            .list_management_connection_events(owner, None, None, 100)
            .await
            .unwrap()
            .events;
        assert_eq!(events.len(), 3);
        assert!(!events.iter().any(|event| event.event == "disconnected"));
        sqlx::query(
            "UPDATE device_access_tokens SET revoked_at='2020-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(&token.info.id)
        .execute(&db.db)
        .await
        .unwrap();
        db.record_management_auth_rejection(&token.token, device, false, None)
            .await
            .unwrap();
        let expired = db
            .create_device_access_token(owner, "expired", None, None)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE device_access_tokens SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(&expired.info.id)
        .execute(&db.db)
        .await
        .unwrap();
        db.record_management_auth_rejection(&expired.token, device, false, None)
            .await
            .unwrap();
        assert_eq!(
            db.list_management_connection_events(owner, None, None, 100)
                .await
                .unwrap()
                .events
                .len(),
            3
        );
        let encoded = serde_json::to_string(&events).unwrap();
        let digest = super::super::device_access_token_hash(&token.token);
        for secret in [&token.token, &expired.token, &digest] {
            assert!(!encoded.contains(secret));
        }
    }

    #[tokio::test]
    async fn event_retention_is_bounded_and_peer_metadata_is_an_ip_only() {
        let db = Db::memory_db().await;
        let owner = owner(&db, "retention-event-owner").await;
        let device = Uuid::new_v4();
        sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10005) INSERT INTO management_connection_events(user_id,device_id,event,reason,occurred_at) SELECT ?,?,'authorized','authorization_granted',? FROM n")
            .bind(owner).bind(device.to_string()).bind(Utc::now().timestamp()).execute(&db.db).await.unwrap();
        sqlx::query("INSERT INTO management_connection_events(user_id,device_id,event,reason,occurred_at) VALUES(?,?,'authorized','authorization_granted',?)")
            .bind(owner).bind(device.to_string()).bind(Utc::now().timestamp()-RETENTION_SECONDS-1).execute(&db.db).await.unwrap();
        db.record_management_connection_event(
            owner,
            device,
            ManagementConnectionEventKind::Authorized,
            Some("https://not-an-ip/secret"),
            Some(1),
        )
        .await
        .unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM management_connection_events WHERE user_id=?")
                .bind(owner)
                .fetch_one(&db.db)
                .await
                .unwrap();
        assert_eq!(count, OWNER_EVENT_LIMIT);
        let latest = db
            .list_management_connection_events(owner, None, None, 1)
            .await
            .unwrap();
        assert_eq!(latest.events[0].peer_ip, None);
        assert!(latest.events[0].occurred_at > 1_000_000_000);
        assert!(latest.next_before_id.is_some());
    }
}
