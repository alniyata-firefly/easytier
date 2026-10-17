use std::{
    future::Future,
    sync::{Mutex as IntentMutex, MutexGuard},
    time::Duration,
};
use tokio::{sync::Mutex, task::JoinHandle};

struct VpnIntent {
    paused: bool,
    stopped: bool,
}

/// Controls Android's system VPN/TUN switch, independently of management and Core instances.
pub(crate) struct LocalClientLifecycle {
    intent: IntentMutex<VpnIntent>,
    operation: Mutex<()>,
    stopping: Mutex<Option<JoinHandle<Result<(), String>>>>,
}

impl LocalClientLifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            intent: IntentMutex::new(VpnIntent {
                paused: true,
                stopped: true,
            }),
            operation: Mutex::const_new(()),
            stopping: Mutex::const_new(None),
        }
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.intent().paused
    }

    pub(crate) fn is_enabled(&self) -> bool {
        !self.is_paused()
    }

    fn intent(&self) -> MutexGuard<'_, VpnIntent> {
        self.intent
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Close the VPN gate from a native callback before queued cleanup can run.
    /// A duplicate notification must not invalidate an already completed stop.
    pub(crate) fn pause_for_native_stop(&self) -> bool {
        let mut intent = self.intent();
        if intent.paused {
            return false;
        }
        intent.paused = true;
        intent.stopped = false;
        true
    }

    pub(crate) async fn stop<F>(&self, deadline: Duration, stop: F) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>> + Send + 'static,
    {
        let _operation = self.operation.lock().await;
        {
            let mut intent = self.intent();
            intent.paused = true;
            intent.stopped = false;
        }
        let mut stopping = self.stopping.lock().await;
        if stopping.is_none() {
            *stopping = Some(tokio::spawn(stop));
        }
        let result = tokio::time::timeout(
            deadline,
            stopping.as_mut().expect("stop task is initialized"),
        )
        .await;
        match result {
            Ok(result) => {
                stopping.take();
                result.map_err(|error| format!("local stop task failed: {error}"))??;
                self.intent().stopped = true;
                Ok(())
            }
            Err(_) => {
                Err("local client is still stopping; retry to wait for completion".to_owned())
            }
        }
    }

    pub(crate) async fn resume(&self) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if self.stopping.lock().await.is_some() {
            return Err("local client has not finished stopping".to_owned());
        }
        let mut intent = self.intent();
        if !intent.stopped {
            return Err("local client has not finished stopping".to_owned());
        }
        intent.paused = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;

    #[test]
    fn cold_process_remains_disabled_when_its_intent_is_queried() {
        let lifecycle = LocalClientLifecycle::new();
        assert!(lifecycle.is_paused());
        assert!(!lifecycle.is_enabled());
        assert!(!lifecycle.is_enabled());
    }

    #[tokio::test]
    async fn explicit_resume_enables_the_same_process_until_stop() {
        let lifecycle = LocalClientLifecycle::new();
        assert!(!lifecycle.is_enabled());
        lifecycle.resume().await.unwrap();
        assert!(lifecycle.is_enabled());
        assert!(lifecycle.is_enabled());
        lifecycle
            .stop(Duration::from_secs(1), async { Ok(()) })
            .await
            .unwrap();
        assert!(!lifecycle.is_enabled());
    }

    #[tokio::test]
    async fn native_revocation_blocks_resume_until_cleanup_and_duplicate_stop_is_harmless() {
        let lifecycle = LocalClientLifecycle::new();
        lifecycle.resume().await.unwrap();
        assert!(lifecycle.pause_for_native_stop());
        assert!(!lifecycle.is_enabled());
        assert!(!lifecycle.pause_for_native_stop());
        assert!(lifecycle.resume().await.is_err());
        lifecycle
            .stop(Duration::from_secs(1), async { Ok(()) })
            .await
            .unwrap();
        assert!(!lifecycle.pause_for_native_stop());
        lifecycle.resume().await.unwrap();
        assert!(lifecycle.is_enabled());
    }

    #[tokio::test]
    async fn native_revocation_and_resume_cannot_leave_the_vpn_gate_enabled() {
        for _ in 0..32 {
            let lifecycle = Arc::new(LocalClientLifecycle::new());
            lifecycle.resume().await.unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let native_lifecycle = lifecycle.clone();
            let native_barrier = barrier.clone();
            let native = std::thread::spawn(move || {
                native_barrier.wait();
                native_lifecycle.pause_for_native_stop()
            });
            barrier.wait();
            let _ = lifecycle.resume().await;
            assert!(native.join().unwrap());
            assert!(!lifecycle.is_enabled());
            assert!(lifecycle.resume().await.is_err());
        }
    }

    #[tokio::test]
    async fn timed_out_stop_keeps_its_task_and_resume_requires_successful_retry() {
        let lifecycle = LocalClientLifecycle::new();
        let release = Arc::new(Notify::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let task_release = release.clone();
        let task_runs = runs.clone();
        assert!(
            lifecycle
                .stop(Duration::from_millis(10), async move {
                    task_runs.fetch_add(1, Ordering::SeqCst);
                    task_release.notified().await;
                    Ok(())
                })
                .await
                .is_err()
        );
        assert!(lifecycle.is_paused());
        assert!(lifecycle.resume().await.is_err());
        release.notify_one();
        lifecycle
            .stop(Duration::from_secs(1), async {
                panic!("retry must await the original task")
            })
            .await
            .unwrap();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        lifecycle.resume().await.unwrap();
        assert!(!lifecycle.is_paused());
    }

    #[tokio::test]
    async fn failed_stop_is_not_a_successful_pause_and_can_be_retried() {
        let lifecycle = LocalClientLifecycle::new();
        assert!(
            lifecycle
                .stop(Duration::from_secs(1), async {
                    Err("fixture cleanup failure".to_owned())
                })
                .await
                .is_err()
        );
        assert!(lifecycle.is_paused());
        assert!(lifecycle.resume().await.is_err());
        lifecycle
            .stop(Duration::from_secs(1), async { Ok(()) })
            .await
            .unwrap();
        lifecycle.resume().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_cancel_cleanup_or_allow_a_restart() {
        let lifecycle = Arc::new(LocalClientLifecycle::new());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let task_lifecycle = lifecycle.clone();
        let task_entered = entered.clone();
        let task_release = release.clone();
        let waiter = tokio::spawn(async move {
            task_lifecycle
                .stop(Duration::from_secs(5), async move {
                    task_entered.notify_one();
                    task_release.notified().await;
                    Ok(())
                })
                .await
        });
        entered.notified().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(lifecycle.resume().await.is_err());
        release.notify_one();
        lifecycle
            .stop(Duration::from_secs(1), async {
                panic!("cleanup must survive its caller")
            })
            .await
            .unwrap();
        lifecycle.resume().await.unwrap();
    }
}
