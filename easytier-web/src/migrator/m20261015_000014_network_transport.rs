use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE networks ADD COLUMN transport_config TEXT NOT NULL DEFAULT '{}'",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE networks DROP COLUMN transport_config")
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::central_network::model::NetworkTransportSettings;
    use sea_orm::{Database, Statement};

    #[tokio::test]
    async fn existing_networks_migrate_to_inherited_transport_without_rewriting_data() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared("CREATE TABLE networks (id TEXT, display_name TEXT); INSERT INTO networks VALUES ('legacy', 'Keep network')").await.unwrap();
        let manager = SchemaManager::new(&db);
        Migration.up(&manager).await.unwrap();
        let row = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                "SELECT id, display_name, transport_config FROM networks".to_owned(),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<String>("", "id").unwrap(), "legacy");
        assert_eq!(
            row.try_get::<String>("", "display_name").unwrap(),
            "Keep network"
        );
        let config: NetworkTransportSettings =
            serde_json::from_str(&row.try_get::<String>("", "transport_config").unwrap()).unwrap();
        assert_eq!(config, NetworkTransportSettings::default());
        Migration.down(&manager).await.unwrap();
        let row = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                "SELECT display_name FROM networks".to_owned(),
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            row.try_get::<String>("", "display_name").unwrap(),
            "Keep network"
        );
    }
}
