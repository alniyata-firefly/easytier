//! Process shutdown policy shared by console and Windows service hosts.

use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(super) const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Starting,
    Running,
    Stopping,
}

/// The process mutation lock orders cleanup after an admitted mutation. This
/// gate also rejects a previously queued request which reaches its hook later.
#[derive(Default)]
pub(super) struct MutationGate {
    closing: AtomicBool,
}

impl MutationGate {
    pub(super) fn close(&self) {
        self.closing.store(true, Ordering::Release);
    }
}

#[async_trait::async_trait]
impl easytier_core::management::InstanceMutationHooks for MutationGate {
    async fn pre_run_network_instance(
        &self,
        _config: &easytier_core::config::toml::TomlConfig,
    ) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            Err("process is shutting down; network starts are disabled".to_owned())
        } else {
            Ok(())
        }
    }
}

/// Close management before polling instance cleanup. The deadline includes
/// waiting for an in-flight management mutation and the instances' own stops.
pub(super) async fn complete<F>(
    close_management: impl FnOnce(),
    stop_instances: F,
    deadline: Duration,
) -> anyhow::Result<()>
where
    F: Future<Output = anyhow::Result<()>>,
{
    close_management();
    tokio::time::timeout(deadline, stop_instances)
        .await
        .map_err(|_| anyhow::anyhow!("graceful process shutdown timed out after {deadline:?}"))?
}

/// Poll progress independently of the operation's current phase. The operation
/// can enter shutdown and suspend again during the same poll.
#[cfg(any(test, target_os = "windows"))]
pub(super) async fn with_progress<F: Future>(
    operation: F,
    mut progress: impl FnMut(),
    interval: Duration,
) -> F::Output {
    tokio::pin!(operation);
    let mut timer = tokio::time::interval(interval);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = &mut operation => return result,
            _ = timer.tick() => progress(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::{Arc, Mutex};

    use easytier_core::management::InstanceMutationHooks as _;

    use super::*;

    #[tokio::test]
    async fn management_closes_before_instance_cleanup_is_polled() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let management_events = events.clone();
        let instance_events = events.clone();
        complete(
            move || management_events.lock().unwrap().push("management closed"),
            async move {
                let mut events = instance_events.lock().unwrap();
                assert_eq!(*events, ["management closed"]);
                events.push("instances stopped");
                Ok(())
            },
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            ["management closed", "instances stopped"]
        );
    }

    #[tokio::test]
    async fn an_unresponsive_mutation_or_instance_cannot_extend_the_deadline() {
        let closed = Arc::new(AtomicBool::new(false));
        let management_closed = closed.clone();
        let result = complete(
            move || management_closed.store(true, Ordering::Release),
            std::future::pending(),
            Duration::from_millis(1),
        )
        .await;
        assert!(closed.load(Ordering::Acquire));
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("shutdown timed out")
        );
    }

    #[tokio::test]
    async fn cleanup_failure_is_reported_instead_of_success() {
        let result = complete(
            || {},
            async { anyhow::bail!("fixture cleanup failure") },
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "fixture cleanup failure");
    }

    #[tokio::test]
    async fn progress_continues_after_a_running_operation_enters_a_pending_stop() {
        let stopping = Cell::new(false);
        let checkpoints = Cell::new(0);
        let released = tokio::sync::Notify::new();
        let operation = async {
            tokio::task::yield_now().await;
            stopping.set(true);
            released.notified().await;
            42
        };
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            with_progress(
                operation,
                || {
                    if stopping.get() {
                        checkpoints.set(checkpoints.get() + 1);
                        released.notify_one();
                    }
                },
                Duration::from_millis(1),
            ),
        )
        .await
        .unwrap();
        assert_eq!(result, 42);
        assert!(checkpoints.get() > 0);
    }

    #[tokio::test]
    async fn a_request_queued_before_shutdown_cannot_start_after_the_gate_closes() {
        let gate = Arc::new(MutationGate::default());
        let config = easytier_core::config::toml::TomlConfig::default();
        assert!(gate.pre_run_network_instance(&config).await.is_ok());
        let queued_gate = gate.clone();
        let queued = async move { queued_gate.pre_run_network_instance(&config).await };
        gate.close();
        assert!(queued.await.is_err());
        gate.close();
        assert!(
            gate.pre_run_network_instance(&Default::default())
                .await
                .is_err()
        );
    }
}
