use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{sync::Mutex, task::JoinHandle};

pub(crate) struct LocalClientLifecycle {
    paused: AtomicBool,
    stopped: AtomicBool,
    operation: Mutex<()>,
    stopping: Mutex<Option<JoinHandle<Result<(), String>>>>,
}

impl LocalClientLifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            stopped: AtomicBool::new(true),
            operation: Mutex::const_new(()),
            stopping: Mutex::const_new(None),
        }
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    pub(crate) async fn stop<F>(&self, deadline: Duration, stop: F) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>> + Send + 'static,
    {
        let _operation = self.operation.lock().await;
        self.paused.store(true, Ordering::Release);
        self.stopped.store(false, Ordering::Release);
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
                self.stopped.store(true, Ordering::Release);
                Ok(())
            }
            Err(_) => {
                Err("local client is still stopping; retry to wait for completion".to_owned())
            }
        }
    }

    pub(crate) async fn resume(&self) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if self.stopping.lock().await.is_some() || !self.stopped.load(Ordering::Acquire) {
            return Err("local client has not finished stopping".to_owned());
        }
        self.paused.store(false, Ordering::Release);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicUsize};
    use tokio::sync::Notify;

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
