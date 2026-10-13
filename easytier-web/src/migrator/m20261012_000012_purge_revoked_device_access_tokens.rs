use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Applied before the new Web accepts sessions. Revoked credential
        // tombstones serve no purpose across a restart and contain no audit
        // history that users need to retain. Leave all effective credentials,
        // registered devices and network configuration untouched.
        manager
            .get_connection()
            .execute_unprepared("DELETE FROM device_access_tokens WHERE revoked_at IS NOT NULL;")
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Deliberately removed credential records cannot be reconstructed.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, DeviceHeartbeatRecord};
    use easytier::{common::config::ConfigSource, proto::api::manage::NetworkConfig};
    use easytier_core::management::remote_client::Storage as _;
    use uuid::Uuid;

    #[tokio::test]
    async fn purge_revoked_tokens_preserves_effective_credentials_devices_and_configs() {
        let db = Db::memory_db().await;
        let owner = db.auto_create_user("purge-owner").await.unwrap().id;
        let other = db.auto_create_user("purge-other").await.unwrap().id;
        let machine = Uuid::new_v4();
        db.upsert_device_heartbeat(DeviceHeartbeatRecord {
            user_id: owner,
            machine_id: machine,
            hostname: "retained-device".into(),
            easytier_version: "2.7".into(),
            device_os: "{}".into(),
            client_url: String::new(),
        })
        .await
        .unwrap();
        let network = Uuid::new_v4();
        db.insert_or_update_user_network_config(
            (owner, machine),
            network,
            NetworkConfig {
                network_name: Some("retained config".into()),
                ..Default::default()
            },
            ConfigSource::User,
        )
        .await
        .unwrap();
        let removed = db
            .create_device_access_token(owner, "old revoked", Some(machine), None)
            .await
            .unwrap();
        let other_removed = db
            .create_device_access_token(other, "other old revoked", None, None)
            .await
            .unwrap();
        db.revoke_device_access_token(owner, &removed.info.id)
            .await
            .unwrap()
            .unwrap();
        db.revoke_device_access_token(other, &other_removed.info.id)
            .await
            .unwrap()
            .unwrap();
        let active = db
            .create_device_access_token(owner, "active", Some(machine), None)
            .await
            .unwrap();
        let pending = db
            .create_device_access_token(owner, "unbound", None, None)
            .await
            .unwrap();
        let expired = db
            .create_device_access_token(owner, "expired but not revoked", None, None)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE device_access_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .bind(&expired.info.id)
        .execute(&db.inner())
        .await
        .unwrap();

        Migration
            .up(&SchemaManager::new(db.orm_db()))
            .await
            .unwrap();
        Migration
            .up(&SchemaManager::new(db.orm_db()))
            .await
            .unwrap();
        assert!(
            db.get_device_access_token(owner, &removed.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.get_device_access_token(other, &other_removed.info.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            db.get_device_access_token(owner, &active.info.id)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            db.get_device_access_token(owner, &pending.info.id)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            db.get_device_access_token(owner, &expired.info.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "expired"
        );
        assert!(db.get_device((owner, machine)).await.unwrap().is_some());
        assert!(
            db.get_network_config((owner, machine), &network.to_string())
                .await
                .unwrap()
                .is_some()
        );
    }
}
