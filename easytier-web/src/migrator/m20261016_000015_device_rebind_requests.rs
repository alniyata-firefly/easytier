use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
            CREATE TABLE device_rebind_requests (
                id TEXT PRIMARY KEY NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_id TEXT NOT NULL REFERENCES device_access_tokens(id) ON DELETE CASCADE,
                auth_generation INTEGER NOT NULL CHECK(auth_generation > 0),
                old_machine_id TEXT NOT NULL,
                new_machine_id TEXT NOT NULL,
                hostname TEXT NOT NULL,
                easytier_version TEXT NOT NULL,
                device_os TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','approved','rejected','superseded')),
                decided_at TEXT,
                UNIQUE(token_id,auth_generation,new_machine_id)
            );
            CREATE INDEX idx_device_rebind_requests_owner
                ON device_rebind_requests(user_id,status,last_seen_at DESC);
        "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE device_rebind_requests;")
            .await?;
        Ok(())
    }
}
