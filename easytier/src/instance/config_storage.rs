use std::{
    io::Write as _,
    path::Path,
    sync::{Arc, OnceLock},
};

use atomic_write_file::{AtomicWriteFile, OpenOptions};

use easytier_core::management::{ConfigFileControl, ConfigFilePermission, ConfigFileStorage};

use crate::common::process_config::parse_process_config_text;

#[derive(Default)]
pub(crate) struct NativeConfigFileStorage;

// Every adapter in this process shares the same lock, including separate local
// RPC and Web clients. A single lock also protects differently spelled aliases
// of one path. Config changes are infrequent and correctness matters more than
// allowing unrelated config files to be rewritten concurrently.
static FILE_MUTATION_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();

async fn file_operation<T: Send + 'static>(
    operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    let lock = FILE_MUTATION_LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(())));
    let guard = lock.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        // RPC cancellation drops the future, not this guard. A started file
        // transaction keeps ownership until its blocking work has completed.
        let _guard = guard;
        operation()
    })
    .await
    .map_err(|_| anyhow::anyhow!("configuration file operation task failed"))?
}

fn read_file(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn atomic_write(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        atomic_write_file::unix::OpenOptionsExt::preserve_mode(&mut options, false);
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    }
    let mut file: AtomicWriteFile = options.open(path)?;
    file.write_all(contents)?;
    file.commit()?;
    Ok(())
}

fn bundle_document(contents: &[u8]) -> Option<toml::Table> {
    let table = std::str::from_utf8(contents)
        .ok()
        .and_then(|text| toml::from_str::<toml::Table>(text).ok())?;
    (table.contains_key("instances") || table.contains_key("host_resources")).then_some(table)
}

fn stored_bundle_document(contents: &[u8]) -> anyhow::Result<Option<toml::Table>> {
    // Instance-scoped mutations fail closed if an operator has left the file
    // malformed. An invalid shared document must not become a legacy rewrite.
    let table = parse_instance_table(contents)?;
    Ok((table.contains_key("instances") || table.contains_key("host_resources")).then_some(table))
}

fn parse_instance_table(contents: &[u8]) -> anyhow::Result<toml::Table> {
    let text = std::str::from_utf8(contents)
        .map_err(|_| anyhow::anyhow!("instance configuration is not UTF-8"))?;
    toml::from_str(text).map_err(|_| anyhow::anyhow!("instance configuration TOML is invalid"))
}

fn dump_table(table: &toml::Table) -> anyhow::Result<String> {
    toml::to_string(table)
        .map_err(|_| anyhow::anyhow!("configuration TOML could not be serialized"))
}

fn validate_bundle(table: &toml::Table) -> anyhow::Result<()> {
    let text = dump_table(table)?;
    let parsed = parse_process_config_text(&text, "configuration storage")
        // Parser diagnostics may contain source lines and credentials. Keep
        // storage errors categorical rather than forwarding source snippets.
        .map_err(|_| anyhow::anyhow!("configuration bundle semantic validation failed"))?;
    anyhow::ensure!(parsed.is_bundle, "configuration is not a process bundle");
    Ok(())
}

fn explicit_instance_id(table: &toml::Table) -> anyhow::Result<uuid::Uuid> {
    let id = table
        .get("instance_id")
        .and_then(toml::Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("instance configuration requires an explicit instance_id")
        })?;
    uuid::Uuid::parse_str(id)
        .map_err(|_| anyhow::anyhow!("instance configuration instance_id is invalid"))
}

fn find_instance_index(
    bundle: &toml::Table,
    instance_id: uuid::Uuid,
) -> anyhow::Result<Option<usize>> {
    let entries = bundle
        .get("instances")
        .and_then(toml::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for (index, entry) in entries.iter().enumerate() {
        let table = entry
            .as_table()
            .ok_or_else(|| anyhow::anyhow!("configuration bundle contains an invalid instance"))?;
        if explicit_instance_id(table)? == instance_id {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

#[async_trait::async_trait]
impl ConfigFileStorage for NativeConfigFileStorage {
    async fn inspect(&self, path: &Path) -> ConfigFileControl {
        let read_only = tokio::fs::metadata(path)
            .await
            .map(|metadata| metadata.permissions().readonly())
            .unwrap_or(true);
        ConfigFileControl::new(
            Some(path.to_owned()),
            if read_only {
                ConfigFilePermission::from(ConfigFilePermission::READ_ONLY)
            } else {
                ConfigFilePermission::default()
            },
        )
    }

    async fn read(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
        let path = path.to_owned();
        file_operation(move || read_file(&path)).await
    }

    async fn write(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        let path = path.to_owned();
        let contents = contents.to_owned();
        file_operation(move || {
            if read_file(&path)?.is_some_and(|current| bundle_document(&current).is_some()) {
                anyhow::bail!("shared process configuration requires an instance-scoped write");
            }
            atomic_write(&path, &contents)
        })
        .await
    }

    async fn remove(&self, path: &Path) -> anyhow::Result<()> {
        let path = path.to_owned();
        file_operation(move || {
            if read_file(&path)?.is_some_and(|current| bundle_document(&current).is_some()) {
                anyhow::bail!("shared process configuration cannot be removed as a whole file");
            }
            std::fs::remove_file(path)?;
            Ok(())
        })
        .await
    }

    async fn read_instance(
        &self,
        path: &Path,
        instance_id: uuid::Uuid,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let path = path.to_owned();
        file_operation(move || {
            let Some(contents) = read_file(&path)? else {
                return Ok(None);
            };
            let Some(bundle) = stored_bundle_document(&contents)? else {
                return Ok(Some(contents));
            };
            validate_bundle(&bundle)?;
            let Some(index) = find_instance_index(&bundle, instance_id)? else {
                return Ok(None);
            };
            let table = bundle["instances"].as_array().unwrap()[index]
                .as_table()
                .unwrap();
            Ok(Some(dump_table(table)?.into_bytes()))
        })
        .await
    }

    async fn write_instance(
        &self,
        path: &Path,
        instance_id: uuid::Uuid,
        contents: &[u8],
    ) -> anyhow::Result<()> {
        let path = path.to_owned();
        let contents = contents.to_owned();
        file_operation(move || {
            let current = read_file(&path)?;
            let Some(mut bundle) = current
                .as_deref()
                .map(stored_bundle_document)
                .transpose()?
                .flatten()
            else {
                // Legacy files may lack an explicit UUID. Their opaque backup
                // and restoration contract is intentionally unchanged.
                return atomic_write(&path, &contents);
            };
            validate_bundle(&bundle)?;
            let replacement = parse_instance_table(&contents)?;
            anyhow::ensure!(
                !replacement.contains_key("instances")
                    && !replacement.contains_key("host_resources"),
                "instance replacement must not contain a process bundle"
            );
            anyhow::ensure!(
                explicit_instance_id(&replacement)? == instance_id,
                "instance replacement UUID does not match the selected instance"
            );
            let index = find_instance_index(&bundle, instance_id)?.ok_or_else(|| {
                anyhow::anyhow!("selected instance is absent from process bundle")
            })?;
            bundle["instances"].as_array_mut().unwrap()[index] = toml::Value::Table(replacement);
            validate_bundle(&bundle)?;
            atomic_write(&path, dump_table(&bundle)?.as_bytes())
        })
        .await
    }

    async fn remove_instance(&self, path: &Path, instance_id: uuid::Uuid) -> anyhow::Result<()> {
        let path = path.to_owned();
        file_operation(move || {
            let Some(contents) = read_file(&path)? else {
                anyhow::bail!("configuration file is absent");
            };
            let Some(mut bundle) = stored_bundle_document(&contents)? else {
                std::fs::remove_file(path)?;
                return Ok(());
            };
            validate_bundle(&bundle)?;
            let index = find_instance_index(&bundle, instance_id)?.ok_or_else(|| {
                anyhow::anyhow!("selected instance is absent from process bundle")
            })?;
            bundle["instances"].as_array_mut().unwrap().remove(index);
            // Keep the process document even when no Instances remain.
            validate_bundle(&bundle)?;
            atomic_write(&path, dump_table(&bundle)?.as_bytes())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST_ID: &str = "80e5e024-7a63-447e-99f1-c4b58d031ad9";
    const SECOND_ID: &str = "24c8d713-026b-4c1f-bf53-0792efa84307";

    fn instance_text(id: &str, name: &str, hostname: &str) -> String {
        format!(
            r#"instance_id = "{id}"
instance_name = "{name}"
hostname = "{hostname}"
listeners = []
[network_identity]
network_name = "fixture-{name}"
network_secret = "fixture-{name}-secret"
[flags]
no_tun = true
"#
        )
    }

    fn bundle_text() -> String {
        let mut bundle = toml::Table::new();
        bundle.insert(
            "host_resources".to_owned(),
            toml::Value::Table(
                toml::from_str(
                    "enabled = false\ninterval_seconds = 7\ndisk_interval_seconds = 70\n",
                )
                .unwrap(),
            ),
        );
        bundle.insert(
            "instances".to_owned(),
            toml::Value::Array(vec![
                toml::Value::Table(
                    parse_instance_table(instance_text(FIRST_ID, "alpha", "first").as_bytes())
                        .unwrap(),
                ),
                toml::Value::Table(
                    parse_instance_table(instance_text(SECOND_ID, "beta", "second").as_bytes())
                        .unwrap(),
                ),
            ]),
        );
        dump_table(&bundle).unwrap()
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.toml");
        let original = bundle_text();
        std::fs::write(&path, &original).unwrap();
        (directory, path, original)
    }

    fn document(path: &Path) -> toml::Table {
        toml::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn selected_table(document: &toml::Table, id: &str) -> toml::Table {
        let index = find_instance_index(document, uuid::Uuid::parse_str(id).unwrap())
            .unwrap()
            .unwrap();
        document["instances"].as_array().unwrap()[index]
            .as_table()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn config_write_is_atomic_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("instance.toml");
        let storage = NativeConfigFileStorage;

        storage.write(&path, b"first").await.unwrap();
        storage.write(&path, b"second").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;

            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn legacy_scoped_restore_preserves_a_file_without_explicit_uuid() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.toml");
        let storage = NativeConfigFileStorage;
        let legacy = b"hostname = \"legacy\"\n[network_identity]\nnetwork_name = \"old\"\n";
        storage.write(&path, legacy).await.unwrap();
        let id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        let backup = storage.read_instance(&path, id).await.unwrap().unwrap();
        assert_eq!(backup, legacy);
        storage
            .write_instance(
                &path,
                id,
                instance_text(FIRST_ID, "alpha", "new").as_bytes(),
            )
            .await
            .unwrap();
        storage.write_instance(&path, id, &backup).await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        storage.remove_instance(&path, id).await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn bundle_read_and_write_are_instance_scoped_and_preserve_policy() {
        let (_directory, path, original) = fixture();
        let storage = NativeConfigFileStorage;
        let id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        let previous = document(&path);
        let backup = storage.read_instance(&path, id).await.unwrap().unwrap();
        assert_eq!(
            parse_instance_table(&backup).unwrap(),
            selected_table(&previous, FIRST_ID)
        );
        assert!(
            !String::from_utf8(backup)
                .unwrap()
                .contains("fixture-beta-secret")
        );
        storage
            .write_instance(
                &path,
                id,
                instance_text(FIRST_ID, "alpha", "changed").as_bytes(),
            )
            .await
            .unwrap();
        let updated = document(&path);
        assert_eq!(updated["host_resources"], previous["host_resources"]);
        assert_eq!(
            selected_table(&updated, SECOND_ID),
            selected_table(&previous, SECOND_ID)
        );
        assert_eq!(
            selected_table(&updated, FIRST_ID)["hostname"].as_str(),
            Some("changed")
        );
        assert_ne!(std::fs::read_to_string(&path).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn concurrent_bundle_updates_from_distinct_adapters_do_not_lose_siblings() {
        let (_directory, path, _) = fixture();
        let first_storage = NativeConfigFileStorage;
        let second_storage = NativeConfigFileStorage;
        let first_id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        let second_id = uuid::Uuid::parse_str(SECOND_ID).unwrap();
        let first = instance_text(FIRST_ID, "alpha", "first-updated");
        let second = instance_text(SECOND_ID, "beta", "second-updated");
        let (a, b) = tokio::join!(
            first_storage.write_instance(&path, first_id, first.as_bytes()),
            second_storage.write_instance(&path, second_id, second.as_bytes())
        );
        a.unwrap();
        b.unwrap();
        let updated = document(&path);
        assert_eq!(
            selected_table(&updated, FIRST_ID)["hostname"].as_str(),
            Some("first-updated")
        );
        assert_eq!(
            selected_table(&updated, SECOND_ID)["hostname"].as_str(),
            Some("second-updated")
        );
    }

    #[tokio::test]
    async fn rollback_restores_only_its_target_after_a_sibling_update() {
        let (_directory, path, _) = fixture();
        let storage = NativeConfigFileStorage;
        let first_id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        let second_id = uuid::Uuid::parse_str(SECOND_ID).unwrap();
        let backup = storage
            .read_instance(&path, first_id)
            .await
            .unwrap()
            .unwrap();
        storage
            .write_instance(
                &path,
                first_id,
                instance_text(FIRST_ID, "alpha", "candidate").as_bytes(),
            )
            .await
            .unwrap();
        storage
            .write_instance(
                &path,
                second_id,
                instance_text(SECOND_ID, "beta", "sibling-new").as_bytes(),
            )
            .await
            .unwrap();
        storage
            .write_instance(&path, first_id, &backup)
            .await
            .unwrap();
        let restored = document(&path);
        assert_eq!(
            selected_table(&restored, FIRST_ID)["hostname"].as_str(),
            Some("first")
        );
        assert_eq!(
            selected_table(&restored, SECOND_ID)["hostname"].as_str(),
            Some("sibling-new")
        );
        assert_eq!(
            restored["host_resources"]["interval_seconds"].as_integer(),
            Some(7)
        );
    }

    #[tokio::test]
    async fn wrong_missing_and_whole_bundle_replacements_are_rejected_without_a_write() {
        let (_directory, path, original) = fixture();
        let storage = NativeConfigFileStorage;
        let id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        for contents in [
            instance_text(SECOND_ID, "beta", "wrong"),
            "instance_name = \"alpha\"\n".to_owned(),
            bundle_text(),
        ] {
            assert!(
                storage
                    .write_instance(&path, id, contents.as_bytes())
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        let absent = uuid::Uuid::new_v4();
        assert!(
            storage
                .read_instance(&path, absent)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            storage
                .write_instance(
                    &path,
                    absent,
                    instance_text(&absent.to_string(), "other", "new").as_bytes()
                )
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[tokio::test]
    async fn invalid_bundle_update_errors_do_not_echo_credentials_or_input() {
        let (_directory, path, original) = fixture();
        let storage = NativeConfigFileStorage;
        let id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        let invalid = format!(
            "instance_id = \"{FIRST_ID}\"\nhostname = 42\n[network_identity]\nnetwork_secret = \"DO_NOT_ECHO_FIXTURE_CREDENTIAL\"\n"
        );
        let error = storage
            .write_instance(&path, id, invalid.as_bytes())
            .await
            .unwrap_err();
        assert!(!format!("{error:#}").contains("DO_NOT_ECHO_FIXTURE_CREDENTIAL"));
        assert!(!format!("{error:#}").contains("hostname = 42"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[tokio::test]
    async fn scoped_delete_keeps_other_instances_and_the_empty_process_document() {
        let (_directory, path, original) = fixture();
        let storage = NativeConfigFileStorage;
        let previous = document(&path);
        assert!(
            storage
                .write(&path, b"hostname = \"replacement\"")
                .await
                .is_err()
        );
        assert!(storage.remove(&path).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        storage
            .remove_instance(&path, uuid::Uuid::parse_str(FIRST_ID).unwrap())
            .await
            .unwrap();
        let remaining = document(&path);
        assert_eq!(remaining["host_resources"], previous["host_resources"]);
        assert_eq!(remaining["instances"].as_array().unwrap().len(), 1);
        assert_eq!(
            selected_table(&remaining, SECOND_ID),
            selected_table(&previous, SECOND_ID)
        );
        storage
            .remove_instance(&path, uuid::Uuid::parse_str(SECOND_ID).unwrap())
            .await
            .unwrap();
        assert!(path.exists());
        let empty = document(&path);
        assert_eq!(empty["host_resources"], previous["host_resources"]);
        assert!(empty["instances"].as_array().unwrap().is_empty());
        validate_bundle(&empty).unwrap();
        assert!(storage.remove(&path).await.is_err());
        assert!(
            storage
                .remove_instance(&path, uuid::Uuid::parse_str(FIRST_ID).unwrap())
                .await
                .is_err()
        );
        assert!(path.exists());
    }

    #[tokio::test]
    async fn resources_only_bundle_is_also_protected_from_whole_file_mutations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.toml");
        let original = "[host_resources]\nenabled = true\n";
        std::fs::write(&path, original).unwrap();
        let storage = NativeConfigFileStorage;
        assert!(
            storage
                .write(&path, b"hostname = \"legacy\"")
                .await
                .is_err()
        );
        assert!(storage.remove(&path).await.is_err());
        assert!(
            storage
                .read_instance(&path, uuid::Uuid::new_v4())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[tokio::test]
    async fn malformed_shared_file_is_not_treated_as_legacy_by_scoped_mutations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.toml");
        let original = "[host_resources]\nenabled = true\n[[instances]\n";
        std::fs::write(&path, original).unwrap();
        let storage = NativeConfigFileStorage;
        let id = uuid::Uuid::parse_str(FIRST_ID).unwrap();
        assert!(storage.read_instance(&path, id).await.is_err());
        assert!(
            storage
                .write_instance(
                    &path,
                    id,
                    instance_text(FIRST_ID, "alpha", "new").as_bytes()
                )
                .await
                .is_err()
        );
        assert!(storage.remove_instance(&path, id).await.is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), original);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn canceled_file_operation_keeps_its_lock_until_blocking_work_finishes() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        };

        let entered = Arc::new(tokio::sync::Notify::new());
        let entered_job = entered.clone();
        let (release, wait_release) = mpsc::channel();
        let first = tokio::spawn(file_operation(move || {
            entered_job.notify_one();
            wait_release.recv_timeout(std::time::Duration::from_secs(10))?;
            Ok(())
        }));
        entered.notified().await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());

        let completed = Arc::new(AtomicBool::new(false));
        let completed_job = completed.clone();
        let second = tokio::spawn(file_operation(move || {
            completed_job.store(true, Ordering::SeqCst);
            Ok(())
        }));
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(!completed.load(Ordering::SeqCst));
        release.send(()).unwrap();
        second.await.unwrap().unwrap();
        assert!(completed.load(Ordering::SeqCst));
    }
}
