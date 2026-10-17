use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use easytier_proto::{
    api::{
        config::{ConfigRpc, InstanceConfigPatch, PatchConfigRequest},
        instance::{InstanceIdentifier, instance_identifier::Selector},
        manage::{
            GetNetworkInstanceConfigRequest, ListNetworkInstanceMetaRequest,
            ListNetworkInstanceRequest, RunNetworkInstanceRequest,
            SaveNetworkInstanceConfigRequest, WebClientService,
        },
    },
    rpc_types::controller::BaseController,
};
use tokio::sync::Notify;

use super::*;
use crate::{
    gateway::dhcp::{DhcpIpv4ApplyOutcome, DhcpIpv4Host},
    host::testkit::{TestDns, TestHost},
    instance::{CoreHostAdapters, CoreInstanceState, CorePacketPlane, InstanceRuntimeHost},
    management::InstanceManagementRpc,
    process_runtime::CoreProcessRuntime,
};

struct TestFactory(Arc<CoreProcessRuntime>);

struct TestRuntime;

#[async_trait::async_trait]
impl DhcpIpv4Host for TestRuntime {
    fn take_interface_closed(&self) -> bool {
        false
    }

    async fn apply_dhcp_ipv4(
        &self,
        _previous: Option<cidr::Ipv4Inet>,
        next: Option<cidr::Ipv4Inet>,
    ) -> DhcpIpv4ApplyOutcome {
        DhcpIpv4ApplyOutcome::applied(next)
    }
}

#[async_trait::async_trait]
impl InstanceRuntimeHost for TestRuntime {
    async fn prepare(
        &self,
        _packet_plane: Arc<CorePacketPlane>,
    ) -> anyhow::Result<Option<Arc<dyn DhcpIpv4Host>>> {
        Ok(Some(Arc::new(TestRuntime)))
    }

    async fn shutdown(&self) {}
}

impl InstanceFactory for TestFactory {
    type Instance = CoreInstance<TestHost>;
    type CreateContext = ();
    type Error = anyhow::Error;

    fn create(&self, config: TomlConfig, (): ()) -> anyhow::Result<Arc<Self::Instance>> {
        let (sink, _receiver) = tokio::sync::mpsc::channel(16);
        let mut adapters = CoreHostAdapters::new(
            Arc::new(TestHost::default()),
            Arc::new(TestDns),
            Arc::new(sink),
            self.0.clone(),
        );
        // The fake runtime has no OS interface. DHCP updates only the in-memory
        // address snapshot while the real Core lifecycle still starts/stops.
        adapters.instance_runtime = Arc::new(TestRuntime);
        CoreInstance::from_toml(config, adapters)
    }
}

#[derive(Default)]
struct Storage {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
    writes: AtomicUsize,
    read_only: AtomicBool,
    fail: AtomicBool,
    block_next: AtomicBool,
    entered: Notify,
    release: Notify,
}

#[async_trait::async_trait]
impl ConfigFileStorage for Storage {
    async fn inspect(&self, path: &Path) -> ConfigFileControl {
        ConfigFileControl::new(
            Some(path.to_owned()),
            if self.read_only.load(Ordering::Acquire) {
                ConfigFilePermission::from(ConfigFilePermission::READ_ONLY)
            } else {
                ConfigFilePermission::default()
            },
        )
    }

    async fn read(&self, path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self.files.lock().unwrap().get(path).cloned())
    }

    async fn write(&self, _path: &Path, _contents: &[u8]) -> anyhow::Result<()> {
        panic!("management must use instance-scoped writes for shared-file safety")
    }

    async fn remove(&self, path: &Path) -> anyhow::Result<()> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }

    async fn write_instance(
        &self,
        path: &Path,
        id: uuid::Uuid,
        contents: &[u8],
    ) -> anyhow::Result<()> {
        assert_eq!(
            TomlConfig::new_from_str(std::str::from_utf8(contents)?)?.get_id(),
            id
        );
        self.writes.fetch_add(1, Ordering::AcqRel);
        if self.block_next.swap(false, Ordering::AcqRel) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        anyhow::ensure!(
            !self.fail.load(Ordering::Acquire),
            "injected durable write failure"
        );
        self.files
            .lock()
            .unwrap()
            .insert(path.to_owned(), contents.to_vec());
        Ok(())
    }
}

#[derive(Default)]
struct Hooks(AtomicUsize);

#[async_trait::async_trait]
impl InstanceMutationHooks for Hooks {
    async fn pre_run_network_instance(&self, _: &TomlConfig) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    async fn post_run_network_instance(&self, _: &uuid::Uuid) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
}

fn manager(directory: Option<&str>) -> Arc<InstanceManager<TestFactory>> {
    Arc::new(
        InstanceManager::new(TestFactory(CoreProcessRuntime::new()), None)
            .with_config_path(directory.map(PathBuf::from)),
    )
}

fn config(id: uuid::Uuid, hostname: &str) -> TomlConfig {
    let config = TomlConfig::default();
    config.set_id(id);
    config.set_hostname(Some(hostname.to_owned()));
    config.set_inst_name(format!("test-{id}"));
    config.set_listeners(Vec::new());
    let mut flags = config.get_flags();
    // TestHost never creates an OS TUN. no_tun=true instead requests Core
    // packet-proxy services, which are absent from the default Core feature set.
    flags.no_tun = false;
    config.set_flags(flags);
    config
}

async fn running(
    manager: &InstanceManager<TestFactory>,
    id: uuid::Uuid,
) -> Arc<CoreInstance<TestHost>> {
    let instance = manager.instance(id).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while instance.state() != CoreInstanceState::Running {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    instance
}

fn patch(id: uuid::Uuid) -> PatchConfigRequest {
    PatchConfigRequest {
        instance: Some(InstanceIdentifier {
            selector: Some(Selector::Id(id.into())),
        }),
        patch: Some(InstanceConfigPatch {
            hostname: Some("patched".into()),
            ..Default::default()
        }),
    }
}

fn file_hostname(storage: &Storage, path: &Path) -> String {
    let files = storage.files.lock().unwrap();
    TomlConfig::new_from_str(std::str::from_utf8(&files[path]).unwrap())
        .unwrap()
        .get_hostname()
}

#[tokio::test]
async fn patch_resolves_current_instance_only_after_process_lock() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    manager
        .run_network_instance(
            config(id, "old"),
            ConfigFileControl::new(Some("old.toml".into()), ConfigFilePermission::default()),
        )
        .unwrap();
    let old = running(&manager, id).await;
    let rpc = InstanceManagementRpc::new_with_config_storage(manager.clone(), storage.clone());
    let guard = manager.mutation_lock().lock_owned().await;
    let pending =
        tokio::spawn(async move { rpc.patch_config(BaseController::default(), patch(id)).await });
    tokio::task::yield_now().await;
    assert!(!pending.is_finished());
    manager.delete_network_instances([id]).await.unwrap();
    manager
        .run_network_instance(
            config(id, "replacement"),
            ConfigFileControl::new(
                Some("replacement.toml".into()),
                ConfigFilePermission::default(),
            ),
        )
        .unwrap();
    let replacement = running(&manager, id).await;
    drop(guard);
    pending.await.unwrap().unwrap();
    assert_eq!(old.toml_config().unwrap().get_hostname().as_str(), "old");
    assert_eq!(
        replacement.toml_config().unwrap().get_hostname().as_str(),
        "patched"
    );
    assert!(
        !storage
            .files
            .lock()
            .unwrap()
            .contains_key(Path::new("old.toml"))
    );
    assert_eq!(
        file_hostname(&storage, Path::new("replacement.toml")),
        "patched"
    );
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn canceled_patch_finishes_commit_before_process_overwrite() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("cancel-patch.toml");
    manager
        .run_network_instance(
            config(id, "old"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    let original = running(&manager, id).await;
    let rpc = InstanceManagementRpc::new_with_config_storage(manager.clone(), storage.clone());
    storage.block_next.store(true, Ordering::Release);
    let call =
        tokio::spawn(async move { rpc.patch_config(BaseController::default(), patch(id)).await });
    storage.entered.notified().await;
    call.abort();
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    let overwrite = tokio::spawn(async move {
        management
            .run_network_instance(config(id, "overwrite"), Some(id), true, None)
            .await
    });
    tokio::task::yield_now().await;
    assert!(!overwrite.is_finished());
    assert!(manager.mutation_lock().try_lock().is_err());
    storage.release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), overwrite)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        original.toml_config().unwrap().get_hostname().as_str(),
        "patched"
    );
    assert_eq!(file_hostname(&storage, &path), "overwrite");
    assert!(!Arc::ptr_eq(&original, &manager.instance(id).unwrap()));
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn save_only_new_config_is_durable_without_instance_or_hooks() {
    let manager = manager(Some("saved-configs"));
    let storage = Arc::new(Storage::default());
    let hooks = Arc::new(Hooks::default());
    let rpc = ProcessManagementRpc::new(manager.clone(), hooks.clone(), storage.clone());
    let id = uuid::Uuid::new_v4();
    let response = rpc
        .save_network_instance_config(
            BaseController::default(),
            SaveNetworkInstanceConfigRequest {
                inst_id: Some(id.into()),
                config: Some(network_config_from_toml(&config(id, "saved"))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(response.inst_id.map(uuid::Uuid::from), Some(id));
    assert_eq!(response.config.unwrap().hostname.as_deref(), Some("saved"));
    assert_eq!(
        file_hostname(&storage, &PathBuf::from(format!("saved-configs/{id}.toml"))),
        "saved"
    );
    assert!(manager.instance_ids().is_empty());
    assert_eq!(hooks.0.load(Ordering::Acquire), 0);
    assert_eq!(storage.writes.load(Ordering::Acquire), 1);
    let list = rpc
        .list_network_instance(BaseController::default(), ListNetworkInstanceRequest {})
        .await
        .unwrap();
    assert!(list.inst_ids.is_empty());
    assert_eq!(list.configured_inst_ids, vec![id.into()]);
    let meta = rpc
        .list_network_instance_meta(
            BaseController::default(),
            ListNetworkInstanceMetaRequest {
                inst_ids: vec![id.into()],
            },
        )
        .await
        .unwrap()
        .metas
        .pop()
        .unwrap();
    assert_eq!(meta.instance_name, format!("test-{id}"));
    assert_eq!(meta.config_permission, 0);
    assert_eq!(meta.source, config_source_to_rpc(ConfigSource::User));
}

#[tokio::test]
async fn stop_preserves_single_file_desired_and_false_overwrite_really_restarts() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("single-cli-config.toml");
    let live = config(id, "live");
    storage
        .files
        .lock()
        .unwrap()
        .insert(path.clone(), live.dump().into_bytes());
    manager
        .run_network_instance(
            live,
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    management
        .save_network_instance_config(config(id, "next-start"), Some(id), None, true)
        .await
        .unwrap();
    management.stop_network_instance(id).await.unwrap();
    assert!(manager.instance_ids().is_empty());
    assert_eq!(file_hostname(&storage, &path), "next-start");
    let rpc = ProcessManagementRpc::new(manager.clone(), Arc::new(()), storage.clone());
    let list = rpc
        .list_network_instance(BaseController::default(), ListNetworkInstanceRequest {})
        .await
        .unwrap();
    assert!(list.inst_ids.is_empty());
    assert_eq!(list.configured_inst_ids, vec![id.into()]);
    let desired = rpc
        .get_network_instance_config(
            BaseController::default(),
            GetNetworkInstanceConfigRequest {
                inst_id: Some(id.into()),
                prefer_persisted: true,
            },
        )
        .await
        .unwrap();
    assert!(desired.persisted);
    rpc.run_network_instance(
        BaseController::default(),
        RunNetworkInstanceRequest {
            inst_id: Some(id.into()),
            config: desired.config,
            overwrite: false,
            source: desired.source,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        running(&manager, id)
            .await
            .toml_config()
            .unwrap()
            .get_hostname(),
        "next-start"
    );
    management.stop_network_instance(id).await.unwrap();
    management.delete_network_instances(vec![id]).await.unwrap();
    assert!(manager.configured_instance_ids().is_empty());
    assert!(!storage.files.lock().unwrap().contains_key(&path));
}

#[tokio::test]
async fn stop_pathless_instance_preserves_core_process_and_read_only_is_rejected() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    manager
        .run_network_instance(
            config(id, "ephemeral"),
            ConfigFileControl::new(None, ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    management.stop_network_instance(id).await.unwrap();
    assert!(manager.instance_ids().is_empty());
    assert_eq!(storage.writes.load(Ordering::Acquire), 0);
    manager
        .run_network_instance(config(id, "static"), ConfigFileControl::STATIC_CONFIG)
        .unwrap();
    let readonly = running(&manager, id).await;
    assert!(
        management
            .stop_network_instance(id)
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only")
    );
    assert!(Arc::ptr_eq(&readonly, &manager.instance(id).unwrap()));
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn explicit_stop_keeps_non_daemon_management_alive_and_delete_releases_it() {
    let manager = manager(None);
    let id = uuid::Uuid::new_v4();
    let management =
        ProcessManagement::new(manager.clone(), Arc::new(()), Arc::new(Storage::default()));
    management
        .run_network_instance(config(id, "ephemeral"), Some(id), true, None)
        .await
        .unwrap();
    running(&manager, id).await;
    management.stop_network_instance(id).await.unwrap();
    management.stop_network_instance(id).await.unwrap();
    let wait = manager.wait();
    tokio::pin!(wait);
    assert!(matches!(
        futures::poll!(wait.as_mut()),
        std::task::Poll::Pending
    ));
    // A pathless stopped Instance has no durable control, but Delete must
    // still release its explicit management hold.
    management.delete_network_instances(vec![id]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), wait)
        .await
        .unwrap();
    assert!(!manager.is_explicitly_stopped(id));
}

#[tokio::test]
async fn successful_run_clears_explicit_stop_without_masking_later_natural_exit() {
    let manager = manager(None);
    let id = uuid::Uuid::new_v4();
    let management =
        ProcessManagement::new(manager.clone(), Arc::new(()), Arc::new(Storage::default()));
    management
        .run_network_instance(config(id, "first"), Some(id), true, None)
        .await
        .unwrap();
    running(&manager, id).await;
    management.stop_network_instance(id).await.unwrap();
    manager
        .run_network_instance(
            config(id, "second"),
            ConfigFileControl::new(None, ConfigFilePermission::default()),
        )
        .unwrap();
    let instance = running(&manager, id).await;
    assert!(!manager.is_explicitly_stopped(id));
    instance.stop().await;
    tokio::time::timeout(Duration::from_secs(3), manager.wait())
        .await
        .unwrap();
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn failed_run_rollback_restores_the_original_explicit_stop_hold() {
    struct RejectPostRun;
    #[async_trait::async_trait]
    impl InstanceMutationHooks for RejectPostRun {
        fn manages_remote_config_instances(&self) -> bool {
            true
        }
        async fn post_run_network_instance(&self, _: &uuid::Uuid) -> Result<(), String> {
            Err("injected post-run failure".into())
        }
    }
    let manager = manager(None);
    let id = uuid::Uuid::new_v4();
    let storage = Arc::new(Storage::default());
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    management
        .run_network_instance(config(id, "first"), Some(id), true, None)
        .await
        .unwrap();
    running(&manager, id).await;
    management.stop_network_instance(id).await.unwrap();
    let rejecting = ProcessManagement::new(manager.clone(), Arc::new(RejectPostRun), storage);
    assert!(
        rejecting
            .run_network_instance(config(id, "rejected"), Some(id), true, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("post-run hook failed")
    );
    assert!(manager.instance_ids().is_empty());
    assert!(manager.is_explicitly_stopped(id));
    let wait = manager.wait();
    tokio::pin!(wait);
    assert!(matches!(
        futures::poll!(wait.as_mut()),
        std::task::Poll::Pending
    ));
    management.delete_network_instances(vec![id]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), wait)
        .await
        .unwrap();
}

#[tokio::test]
async fn save_only_existing_config_preserves_live_actor_and_current_settings() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("existing.toml");
    manager
        .run_network_instance(
            config(id, "live"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    let live = running(&manager, id).await;
    let hooks = Arc::new(Hooks::default());
    let management = ProcessManagement::new(manager.clone(), hooks.clone(), storage.clone());
    management
        .save_network_instance_config(config(id, "next-start"), Some(id), None, true)
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&live, &manager.instance(id).unwrap()));
    assert_eq!(live.state(), CoreInstanceState::Running);
    assert_eq!(live.toml_config().unwrap().get_hostname().as_str(), "live");
    assert_eq!(file_hostname(&storage, &path), "next-start");
    assert_eq!(hooks.0.load(Ordering::Acquire), 0);
    assert_eq!(
        management
            .saved_network_instance_config(id)
            .await
            .unwrap()
            .get_hostname()
            .as_str(),
        "next-start",
    );
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn persisted_read_survives_controller_reconnect_without_running_instance() {
    let storage = Arc::new(Storage::default());
    let first = manager(Some("saved-configs"));
    let id = uuid::Uuid::new_v4();
    ProcessManagement::new(first, Arc::new(()), storage.clone())
        .save_network_instance_config(config(id, "persisted"), Some(id), None, true)
        .await
        .unwrap();
    let reconnected = manager(Some("saved-configs"));
    let rpc = ProcessManagementRpc::new(reconnected.clone(), Arc::new(()), storage);
    let response = rpc
        .get_network_instance_config(
            BaseController::default(),
            GetNetworkInstanceConfigRequest {
                inst_id: Some(id.into()),
                prefer_persisted: true,
            },
        )
        .await
        .unwrap();
    assert!(response.persisted);
    assert_eq!(
        response.config.unwrap().hostname.as_deref(),
        Some("persisted")
    );
    assert!(reconnected.instance_ids().is_empty());
}

#[tokio::test]
async fn persisted_read_never_falls_back_to_live_or_accepts_another_uuid() {
    let manager = manager(Some("saved-configs"));
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("live-without-file.toml");
    manager
        .run_network_instance(
            config(id, "live"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let rpc = ProcessManagementRpc::new(manager.clone(), Arc::new(()), storage.clone());
    let read = || GetNetworkInstanceConfigRequest {
        inst_id: Some(id.into()),
        prefer_persisted: true,
    };
    assert!(
        rpc.get_network_instance_config(BaseController::default(), read())
            .await
            .unwrap_err()
            .to_string()
            .contains("not found")
    );
    storage.files.lock().unwrap().insert(
        path.clone(),
        config(uuid::Uuid::new_v4(), "wrong-uuid")
            .dump()
            .into_bytes(),
    );
    assert!(
        rpc.get_network_instance_config(BaseController::default(), read())
            .await
            .unwrap_err()
            .to_string()
            .contains("UUID mismatch")
    );
    let live = rpc
        .get_network_instance_config(
            BaseController::default(),
            GetNetworkInstanceConfigRequest {
                inst_id: Some(id.into()),
                prefer_persisted: false,
            },
        )
        .await
        .unwrap();
    assert!(!live.persisted);
    assert_eq!(live.config.unwrap().hostname.as_deref(), Some("live"));
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn save_only_cannot_bypass_controller_owned_source_or_static_permissions() {
    let manager = manager(Some("saved-configs"));
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let managed = config(id, "managed");
    managed.set_network_config_source(Some(ConfigSource::Web));
    manager
        .run_network_instance(
            managed,
            ConfigFileControl::new(Some("managed.toml".into()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    assert!(
        management
            .save_network_instance_config(
                config(id, "user"),
                Some(id),
                Some(ConfigSource::User),
                true
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("through its controller")
    );
    manager.delete_network_instances([id]).await.unwrap();
    manager
        .run_network_instance(config(id, "static"), ConfigFileControl::STATIC_CONFIG)
        .unwrap();
    running(&manager, id).await;
    assert!(
        management
            .save_network_instance_config(config(id, "save"), Some(id), None, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only")
    );
    assert_eq!(storage.writes.load(Ordering::Acquire), 0);
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn unapplied_save_rejects_hot_patch_until_full_apply_without_losing_desired_file() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("pending-desired.toml");
    manager
        .run_network_instance(
            config(id, "live"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    management
        .save_network_instance_config(config(id, "saved-desired"), Some(id), None, true)
        .await
        .unwrap();
    let rpc = InstanceManagementRpc::new_with_config_storage(manager.clone(), storage.clone());
    let writes = storage.writes.load(Ordering::Acquire);
    assert!(
        rpc.patch_config(BaseController::default(), patch(id))
            .await
            .unwrap_err()
            .to_string()
            .contains("unapplied saved configuration")
    );
    assert_eq!(storage.writes.load(Ordering::Acquire), writes);
    assert_eq!(file_hostname(&storage, &path), "saved-desired");
    let saved = management.saved_network_instance_config(id).await.unwrap();
    management
        .run_network_instance(saved, Some(id), true, None)
        .await
        .unwrap();
    running(&manager, id).await;
    rpc.patch_config(BaseController::default(), patch(id))
        .await
        .unwrap();
    assert_eq!(file_hostname(&storage, &path), "patched");
    manager.delete_network_instances([id]).await.unwrap();
}

#[cfg(feature = "dhcp-ipv4")]
#[tokio::test]
async fn dhcp_lease_and_default_normalization_do_not_mark_identical_save_pending() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let live = config(id, "same");
    live.set_dhcp(true);
    live.set_ipv4(Some("100.64.0.5/24".parse().unwrap()));
    manager
        .run_network_instance(
            live,
            ConfigFileControl::new(Some("dhcp.toml".into()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    let declarative = config(id, "same");
    declarative.set_dhcp(true);
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    management
        .save_network_instance_config(declarative, Some(id), None, true)
        .await
        .unwrap();
    assert!(!manager.has_pending_config_save(id));
    let rpc = InstanceManagementRpc::new_with_config_storage(manager.clone(), storage.clone());
    rpc.patch_config(BaseController::default(), patch(id))
        .await
        .unwrap();
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn persisted_legacy_file_without_id_uses_registered_identity() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let path = PathBuf::from("legacy.toml");
    manager
        .run_network_instance(
            config(id, "live"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    running(&manager, id).await;
    storage
        .files
        .lock()
        .unwrap()
        .insert(path, b"hostname = 'legacy'".to_vec());
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage);
    let saved = management.saved_network_instance_config(id).await.unwrap();
    assert_eq!(saved.get_id(), id);
    assert_eq!(saved.get_hostname(), "legacy");
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn save_only_rejects_pathless_read_only_and_failed_storage() {
    let manager = manager(None);
    let storage = Arc::new(Storage::default());
    let id = uuid::Uuid::new_v4();
    let management = ProcessManagement::new(manager.clone(), Arc::new(()), storage.clone());
    let error = management
        .save_network_instance_config(config(id, "save"), Some(id), None, true)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("durable save is unsupported"));
    assert_eq!(storage.writes.load(Ordering::Acquire), 0);
    let path = PathBuf::from("readonly.toml");
    let before = config(id, "before").dump().into_bytes();
    storage
        .files
        .lock()
        .unwrap()
        .insert(path.clone(), before.clone());
    manager
        .run_network_instance(
            config(id, "before"),
            ConfigFileControl::new(Some(path.clone()), ConfigFilePermission::default()),
        )
        .unwrap();
    let live = running(&manager, id).await;
    storage.read_only.store(true, Ordering::Release);
    assert!(
        management
            .save_network_instance_config(config(id, "blocked"), Some(id), None, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only")
    );
    storage.read_only.store(false, Ordering::Release);
    storage.fail.store(true, Ordering::Release);
    assert!(
        management
            .save_network_instance_config(config(id, "failed"), Some(id), None, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("failed to persist")
    );
    assert_eq!(storage.files.lock().unwrap()[&path], before);
    assert!(Arc::ptr_eq(&live, &manager.instance(id).unwrap()));
    assert_eq!(
        live.toml_config().unwrap().get_hostname().as_str(),
        "before"
    );
    manager.delete_network_instances([id]).await.unwrap();
}

#[tokio::test]
async fn canceled_save_retains_process_lock_until_durable_write_finishes() {
    let manager = manager(Some("saved-configs"));
    let storage = Arc::new(Storage::default());
    storage.block_next.store(true, Ordering::Release);
    let rpc = ProcessManagementRpc::new(manager.clone(), Arc::new(()), storage.clone());
    let id = uuid::Uuid::new_v4();
    let call = tokio::spawn(async move {
        rpc.save_network_instance_config(
            BaseController::default(),
            SaveNetworkInstanceConfigRequest {
                inst_id: Some(id.into()),
                config: Some(network_config_from_toml(&config(id, "saved"))),
                ..Default::default()
            },
        )
        .await
    });
    storage.entered.notified().await;
    call.abort();
    assert!(manager.mutation_lock().try_lock().is_err());
    storage.release.notify_one();
    let lock = manager.mutation_lock();
    let guard = tokio::time::timeout(Duration::from_secs(3), lock.lock())
        .await
        .unwrap();
    drop(guard);
    assert!(manager.instance_ids().is_empty());
    assert_eq!(
        file_hostname(&storage, &PathBuf::from(format!("saved-configs/{id}.toml"))),
        "saved"
    );
}
