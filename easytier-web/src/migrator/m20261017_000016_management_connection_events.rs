use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            CREATE TABLE management_connection_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                event TEXT NOT NULL CHECK(event IN ('authorized','disconnected','authentication_rejected','pending_approval','configuration_apply_failed')),
                reason TEXT NOT NULL CHECK(reason IN ('authorization_granted','connection_closed','authorization_lost','device_identity_mismatch','device_rebind_required','node_reported_failure','configuration_rpc_failed')),
                occurred_at INTEGER NOT NULL,
                peer_ip TEXT,
                instance_id TEXT
            );
            CREATE INDEX idx_management_events_owner ON management_connection_events(user_id,id DESC);
            CREATE INDEX idx_management_events_device ON management_connection_events(user_id,device_id,id DESC);
            CREATE INDEX idx_management_events_retention ON management_connection_events(user_id,occurred_at);
            CREATE INDEX idx_management_events_age ON management_connection_events(occurred_at);
            CREATE TABLE management_connection_event_states (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('connection','configuration','authentication_attempt')),
                instance_id TEXT NOT NULL DEFAULT '',
                event TEXT NOT NULL,
                reason TEXT NOT NULL,
                server_epoch TEXT NOT NULL,
                session_epoch INTEGER,
                snapshot_revision INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(user_id,device_id,category,instance_id)
            );
            CREATE INDEX idx_management_event_states_retention ON management_connection_event_states(user_id,updated_at);
            CREATE INDEX idx_management_event_states_age ON management_connection_event_states(updated_at);
        "#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(
            "DROP TABLE management_connection_event_states; DROP TABLE management_connection_events;",
        ).await?;
        Ok(())
    }
}
