use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(r#"
            CREATE TABLE device_access_tokens (
                id TEXT PRIMARY KEY NOT NULL,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                machine_id TEXT,
                created_at TEXT NOT NULL,
                bound_at TEXT,
                last_used_at TEXT,
                expires_at TEXT,
                revoked_at TEXT,
                auth_generation INTEGER NOT NULL DEFAULT 1 CHECK(auth_generation > 0)
            );
            CREATE INDEX idx_device_access_tokens_owner ON device_access_tokens(user_id, created_at);
            CREATE INDEX idx_device_access_tokens_device ON device_access_tokens(user_id, machine_id);
        "#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE device_access_tokens;")
            .await?;
        Ok(())
    }
}
