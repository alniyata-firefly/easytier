use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;
use uuid::Uuid;

/// Identifies one native VPN request, including any installation still pending.
pub(super) struct AndroidTunLease {
    pub(super) instance_id: Uuid,
    pub(super) request_id: String,
    cancelled: watch::Sender<bool>,
}

impl AndroidTunLease {
    pub(super) fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    /// Observes cancellation even when it happened before this future was polled.
    pub(super) async fn cancelled(&self) {
        let mut receiver = self.cancelled.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }

    fn cancel(&self) {
        // Unlike send(), this preserves cancellation without any live receiver.
        self.cancelled.send_replace(true);
    }
}

/// Coordinates request identity; the caller owns NIC cleanup and its lock.
///
/// Cancellation deliberately retains the current lease until cleanup finishes.
/// That allows native callbacks to invalidate a pending install immediately,
/// while cleanup later compares the exact lease under the instance mutation lock.
pub(super) struct AndroidTunLeases {
    current: Mutex<Option<Arc<AndroidTunLease>>>,
}

impl AndroidTunLeases {
    pub(super) const fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    fn lock_current(&self) -> MutexGuard<'_, Option<Arc<AndroidTunLease>>> {
        self.current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn current(&self) -> Option<Arc<AndroidTunLease>> {
        self.lock_current().clone()
    }

    pub(super) fn begin(&self, instance_id: Uuid, request_id: String) -> Arc<AndroidTunLease> {
        let (cancelled, _) = watch::channel(false);
        let lease = Arc::new(AndroidTunLease {
            instance_id,
            request_id,
            cancelled,
        });
        if let Some(previous) = self.lock_current().replace(lease.clone()) {
            previous.cancel();
        }
        lease
    }

    /// Invalidates only the request described by a native stop snapshot.
    pub(super) fn cancel_matching(
        &self,
        instance_id: Uuid,
        request_id: &str,
    ) -> Option<Arc<AndroidTunLease>> {
        let current = self.lock_current();
        let lease = current.as_ref()?;
        if lease.instance_id != instance_id || lease.request_id != request_id {
            return None;
        }
        lease.cancel();
        Some(lease.clone())
    }

    /// Identity only: a cancelled current lease must still be eligible for cleanup.
    pub(super) fn is_current(&self, lease: &Arc<AndroidTunLease>) -> bool {
        self.lock_current()
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, lease))
    }

    /// Call after cleanup while holding the caller's instance mutation lock.
    /// A late completion for an older request never clears a newer owner.
    pub(super) fn finish_if_current(&self, lease: &Arc<AndroidTunLease>) -> bool {
        let mut current = self.lock_current();
        if !current
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, lease))
        {
            return false;
        }
        lease.cancel();
        current.take();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{ErrorKind, Read},
        os::{fd::OwnedFd, unix::net::UnixStream},
        time::Duration,
    };

    fn instance(value: u128) -> Uuid {
        Uuid::from_u128(value)
    }

    fn resource() -> (OwnedFd, UnixStream) {
        let (owned, observer) = UnixStream::pair().unwrap();
        observer.set_nonblocking(true).unwrap();
        (owned.into(), observer)
    }

    fn assert_open(observer: &mut UnixStream) {
        assert_eq!(
            observer.read(&mut [0]).unwrap_err().kind(),
            ErrorKind::WouldBlock
        );
    }

    fn assert_closed(observer: &mut UnixStream) {
        assert_eq!(observer.read(&mut [0]).unwrap(), 0);
    }

    #[test]
    fn replacement_cancels_the_previous_generation_and_old_cleanup_cannot_finish_new_owner() {
        let leases = AndroidTunLeases::new();
        let old = leases.begin(instance(1), "request-a".into());
        let next = leases.begin(instance(1), "request-b".into());
        assert!(old.is_cancelled());
        assert!(!leases.is_current(&old));
        assert!(!leases.finish_if_current(&old));
        assert!(leases.is_current(&next));
        assert!(Arc::ptr_eq(&leases.current().unwrap(), &next));
        assert!(!next.is_cancelled());
    }

    #[test]
    fn stop_requires_both_identifiers_and_retains_the_cancelled_owner_until_cleanup() {
        let leases = AndroidTunLeases::new();
        let lease = leases.begin(instance(1), "request-a".into());
        assert!(leases.cancel_matching(instance(2), "request-a").is_none());
        assert!(leases.cancel_matching(instance(1), "request-b").is_none());
        assert!(!lease.is_cancelled());
        let cancelled = leases.cancel_matching(instance(1), "request-a").unwrap();
        assert!(Arc::ptr_eq(&cancelled, &lease));
        assert!(lease.is_cancelled());
        assert!(leases.is_current(&lease));
        assert!(leases.finish_if_current(&lease));
        assert!(!leases.finish_if_current(&lease));
        assert!(!leases.is_current(&lease));
    }

    #[test]
    fn repeated_text_identifiers_do_not_make_an_old_lease_current_again() {
        let leases = AndroidTunLeases::new();
        let old = leases.begin(instance(1), "same-request".into());
        let next = leases.begin(instance(1), "same-request".into());
        assert!(!leases.is_current(&old));
        assert!(leases.is_current(&next));
        assert!(!leases.finish_if_current(&old));
    }

    #[tokio::test]
    async fn cancellation_before_subscription_is_observed_without_an_event_listener() {
        let leases = AndroidTunLeases::new();
        let lease = leases.begin(instance(1), "request-a".into());
        leases.cancel_matching(instance(1), "request-a").unwrap();
        tokio::time::timeout(Duration::from_secs(1), lease.cancelled())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn stopping_a_pending_install_releases_its_fake_descriptor_instead_of_committing() {
        let leases = AndroidTunLeases::new();
        let lease = leases.begin(instance(1), "request-a".into());
        let (owned, mut observer) = resource();
        let entered = Arc::new(tokio::sync::Notify::new());
        let entered_by_install = entered.clone();
        let installing = lease.clone();
        let pending = tokio::spawn(async move {
            let _owned = owned;
            entered_by_install.notify_one();
            tokio::select! {
                biased;
                _ = installing.cancelled() => false,
                _ = std::future::pending::<()>() => true,
            }
        });
        entered.notified().await;
        assert_open(&mut observer);
        leases.cancel_matching(instance(1), "request-a").unwrap();
        assert!(
            !tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap()
        );
        assert_closed(&mut observer);
        assert!(leases.finish_if_current(&lease));
    }

    #[test]
    fn dropping_an_unpolled_install_releases_its_owned_descriptor() {
        let (owned, mut observer) = resource();
        let pending = async move {
            let _owned = owned;
            std::future::pending::<()>().await;
        };
        assert_open(&mut observer);
        drop(pending);
        assert_closed(&mut observer);
    }

    #[test]
    fn late_cleanup_keeps_a_new_bindings_descriptor_alive() {
        let leases = AndroidTunLeases::new();
        let old = leases.begin(instance(1), "request-a".into());
        let next = leases.begin(instance(1), "request-b".into());
        let (owned, mut observer) = resource();
        let mut installed = Some(owned);
        if leases.finish_if_current(&old) {
            installed.take();
        }
        assert_open(&mut observer);
        assert!(leases.finish_if_current(&next));
        installed.take();
        assert_closed(&mut observer);
    }
}
