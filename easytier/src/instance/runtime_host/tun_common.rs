use std::{
    any::Any,
    sync::{Arc, OnceLock},
};

use easytier_core::host::packet::HostPacketReceiver;
use tokio::{sync::Mutex, task::JoinSet};

use super::MagicDnsRuntime;
use crate::instance::virtual_nic::NicCtx;

struct NicCtxContainer {
    _nic_ctx: Option<Box<dyn Any + Send>>,
    magic_dns: MagicDnsRuntime,
}

impl NicCtxContainer {
    fn new(nic_ctx: NicCtx, magic_dns: MagicDnsRuntime) -> Self {
        Self {
            _nic_ctx: Some(Box::new(nic_ctx)),
            magic_dns,
        }
    }

    fn packet_drain(tasks: JoinSet<()>) -> Self {
        Self {
            _nic_ctx: Some(Box::new(tasks)),
            magic_dns: MagicDnsRuntime::default(),
        }
    }
}

#[derive(Clone)]
pub(super) struct TunNicState {
    nic_ctx: Arc<Mutex<Option<NicCtxContainer>>>,
    receiver: Arc<OnceLock<Arc<Mutex<HostPacketReceiver>>>>,
}

impl TunNicState {
    pub(super) fn empty() -> Self {
        Self {
            nic_ctx: Arc::new(Mutex::new(None)),
            receiver: Arc::new(OnceLock::new()),
        }
    }

    pub(super) fn install_receiver(&self, receiver: HostPacketReceiver) -> anyhow::Result<()> {
        self.receiver
            .set(Arc::new(Mutex::new(receiver)))
            .map_err(|_| anyhow::anyhow!("native packet receiver is already installed"))
    }

    pub(super) fn receiver(&self) -> Arc<Mutex<HostPacketReceiver>> {
        self.receiver
            .get()
            .expect("packet receiver must be installed before preparing TUN")
            .clone()
    }

    pub(super) async fn stop(&self) {
        let mut old = self.nic_ctx.lock().await.take();
        if let Some(nic) = old.as_mut() {
            nic.magic_dns.stop().await;
            #[cfg(mobile)]
            if let Some(nic_ctx) = nic
                ._nic_ctx
                .as_mut()
                .and_then(|context| context.downcast_mut::<NicCtx>())
            {
                // Await real adapter task destruction before releasing its
                // descriptor. Cancellation remains safe via each task's owner.
                nic_ctx.stop_mobile().await;
            }
        }
        drop(old);
    }

    pub(super) async fn drain(&self) {
        self.stop().await;
        let receiver = self.receiver();
        let mut tasks = JoinSet::new();
        tasks.spawn(async move {
            let mut receiver = receiver.lock().await;
            while let Some(packet) = receiver.recv().await {
                tracing::trace!(?packet, "discarded packet without a native interface");
            }
        });
        self.nic_ctx
            .lock()
            .await
            .replace(NicCtxContainer::packet_drain(tasks));
    }

    pub(super) async fn install(&self, nic: NicCtx, magic_dns: MagicDnsRuntime) {
        self.stop().await;
        self.nic_ctx
            .lock()
            .await
            .replace(NicCtxContainer::new(nic, magic_dns));
    }

    #[cfg(mobile)]
    pub(super) fn install_mobile(
        &self,
        nic: NicCtx,
        magic_dns: MagicDnsRuntime,
        cancel: tokio_util::sync::CancellationToken,
    ) -> impl std::future::Future<Output = anyhow::Result<()>> + '_ {
        let next = NicCtxContainer::new(nic, magic_dns);
        async move {
            self.stop().await;
            let mut current = self.nic_ctx.lock().await;
            if cancel.is_cancelled() {
                anyhow::bail!("instance is closing; TUN attachment cancelled");
            }
            current.replace(next);
            // No suspension after commit: completion means the owned NIC is
            // installed, rather than a request left for a background worker.
            Ok(())
        }
    }
}
