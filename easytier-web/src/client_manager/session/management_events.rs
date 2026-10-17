//! Bounded best-effort diagnostics, independent from authorization and free of
//! credentials and raw configuration/error strings.
use std::{collections::HashSet, future::Future, time::Duration};

use super::{SessionData, SessionRpcService, SharedSessionData};
use crate::{
    client_manager::storage::{Storage, StorageToken},
    db::{Db, ManagementConnectionEventKind, ManagementFailureReason},
};

struct EventContext {
    db: Db,
    owner: i32,
    device: uuid::Uuid,
    peer_ip: Option<String>,
    epoch: u64,
}

impl EventContext {
    fn new(db: &Db, token: &StorageToken, epoch: u64) -> Self {
        Self {
            db: db.clone(),
            owner: token.user_id,
            device: token.machine_id,
            peer_ip: token.client_url.host_str().map(str::to_owned),
            epoch,
        }
    }
}

async fn persisted<T>(operation: impl Future<Output = Result<T, sea_orm::DbErr>>) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_millis(500), operation).await,
        Ok(Ok(_))
    )
}

pub(super) fn queue_connection(
    storage: &Storage,
    token: &StorageToken,
    epoch: u64,
    kind: ManagementConnectionEventKind,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let context = EventContext::new(storage.db(), token, epoch);
    runtime.spawn(async move {
        if !persisted(context.db.record_management_connection_event(
            context.owner,
            context.device,
            kind,
            context.peer_ip.as_deref(),
            Some(context.epoch),
        ))
        .await
        {
            tracing::warn!("management connection event could not be persisted");
        }
    });
}

struct FailureSnapshot {
    context: EventContext,
    revision: u64,
    failures: Vec<(uuid::Uuid, ManagementFailureReason)>,
}

fn failure_snapshot(data: &mut SessionData, ids: &HashSet<String>) -> Option<FailureSnapshot> {
    if !data.auth_state.is_authorized() {
        return None;
    }
    let storage = data.storage.upgrade()?;
    let token = data.storage_token.as_ref()?;
    if !storage.owns_authorized_session(token, data.session_epoch) {
        return None;
    }
    let context = EventContext::new(&storage.db, token, data.session_epoch);
    let mut failures = ids
        .iter()
        .filter_map(|id| {
            Some((
                uuid::Uuid::parse_str(id).ok()?,
                if data.direct_run_failed_instance_ids.contains(id) {
                    ManagementFailureReason::ConfigurationRpc
                } else {
                    ManagementFailureReason::NodeReported
                },
            ))
        })
        .collect::<Vec<_>>();
    failures.sort_unstable_by_key(|(id, _)| *id);
    failures.truncate(256);
    data.management_event_revision = data.management_event_revision.wrapping_add(1);
    Some(FailureSnapshot {
        context,
        revision: data.management_event_revision,
        failures,
    })
}

async fn record_failures(snapshot: FailureSnapshot) {
    let context = snapshot.context;
    if !persisted(context.db.sync_management_config_failures(
        context.owner,
        context.device,
        &snapshot.failures,
        context.peer_ip.as_deref(),
        context.epoch,
        snapshot.revision,
    ))
    .await
    {
        tracing::warn!("management configuration event could not be persisted");
    }
}

pub(super) fn queue_failures(data: &mut SessionData, ids: &HashSet<String>) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    if let Some(snapshot) = failure_snapshot(data, ids) {
        runtime.spawn(record_failures(snapshot));
    }
}

pub(super) async fn record_authorized(session: &SharedSessionData) {
    let Some(context) = ({
        let data = session.read().await;
        if data.auth_state.is_authorized() {
            data.storage.upgrade().and_then(|storage| {
                let token = data.storage_token.as_ref()?;
                storage
                    .owns_authorized_session(token, data.session_epoch)
                    .then(|| EventContext::new(&storage.db, token, data.session_epoch))
            })
        } else {
            None
        }
    }) else {
        return;
    };
    if !persisted(context.db.record_management_connection_event(
        context.owner,
        context.device,
        ManagementConnectionEventKind::Authorized,
        context.peer_ip.as_deref(),
        Some(context.epoch),
    ))
    .await
    {
        tracing::warn!("management authorization event could not be persisted");
    }
    let snapshot = {
        let mut data = session.write().await;
        if data.session_epoch != context.epoch {
            return;
        }
        let ids = SessionRpcService::failed_instance_ids_locked(&data);
        failure_snapshot(&mut data, &ids)
    };
    if let Some(snapshot) = snapshot {
        record_failures(snapshot).await;
    }
}
