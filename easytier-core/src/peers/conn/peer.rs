use std::sync::Arc;

use arc_swap::ArcSwapOption;
use crossbeam::atomic::AtomicCell;
use dashmap::{DashMap, DashSet};
use parking_lot::{Mutex, RwLock};

use tokio::{select, sync::mpsc};

use tracing::Instrument;

use super::peer_conn::{PeerConn, PeerConnId};
use crate::peers::{
    PacketRecvChan,
    context::{ArcPeerContext, PeerEvent},
    util::shrink_dashmap,
};
use crate::{
    config::PeerId,
    packet::ZCPacket,
    peers::error::Error,
    proto::{core_peer::peer::PeerConnInfo, peer_rpc::PeerIdentityType},
};
use tokio_util::task::AbortOnDropHandle;

type ArcPeerConn = Arc<PeerConn>;
type ConnMap = Arc<DashMap<PeerConnId, ArcPeerConn>>;

fn conn_latency_sort_key(latency_us: u64, is_hole_punched: bool) -> (bool, u64) {
    (is_hole_punched && latency_us == 0, latency_us)
}

fn preferred_conn_sort_key(
    latency_us: u64,
    is_hole_punched: bool,
    is_ipv6: bool,
    confirmed: bool,
) -> (u8, u64) {
    let rank = match (confirmed, is_ipv6, is_hole_punched) {
        (true, true, _) => 0,
        (true, false, _) => 1,
        (false, _, false) => 2,
        (false, _, true) => 3,
    };
    (rank, latency_us)
}

fn preferred_key(conn: &PeerConn) -> (u8, u64) {
    preferred_conn_sort_key(
        conn.get_stats().latency_us,
        conn.is_hole_punched(),
        conn.uses_ipv6_underlay(),
        conn.has_confirmed_liveness(),
    )
}

pub struct Peer {
    pub peer_node_id: PeerId,
    conns: ConnMap,
    context: ArcPeerContext,

    packet_recv_chan: PacketRecvChan,

    close_event_sender: mpsc::Sender<PeerConnId>,
    #[allow(dead_code)]
    close_event_listener: AbortOnDropHandle<()>,

    shutdown_notifier: Arc<tokio::sync::Notify>,

    default_conn: Arc<ArcSwapOption<PeerConn>>,
    default_conn_update_lock: Arc<Mutex<()>>,
    peer_identity_type: Arc<AtomicCell<Option<PeerIdentityType>>>,
    peer_public_key: Arc<RwLock<Option<Vec<u8>>>>,
    #[allow(dead_code)]
    default_conn_clear_task: AbortOnDropHandle<()>,
}

impl Peer {
    pub(crate) fn new(
        peer_node_id: PeerId,
        packet_recv_chan: PacketRecvChan,
        context: ArcPeerContext,
    ) -> Self {
        let conns: ConnMap = Arc::new(DashMap::new());
        let (close_event_sender, mut close_event_receiver) = mpsc::channel(10);
        let shutdown_notifier = Arc::new(tokio::sync::Notify::new());
        let peer_identity_type = Arc::new(AtomicCell::new(None));
        let peer_identity_type_copy = peer_identity_type.clone();
        let peer_public_key = Arc::new(RwLock::new(None));
        let peer_public_key_copy = peer_public_key.clone();
        let default_conn = Arc::new(ArcSwapOption::empty());
        let default_conn_update_lock = Arc::new(Mutex::new(()));

        let conns_copy = conns.clone();
        let shutdown_notifier_copy = shutdown_notifier.clone();
        let context_copy = context.clone();
        let default_conn_copy = default_conn.clone();
        let default_conn_update_lock_copy = default_conn_update_lock.clone();
        let close_event_listener = AbortOnDropHandle::new(tokio::spawn(
            async move {
                loop {
                    select! {
                        ret = close_event_receiver.recv() => {
                            if ret.is_none() {
                                break;
                            }
                            let ret = ret.unwrap();
                            tracing::warn!(
                                ?peer_node_id,
                                ?ret,
                                "notified that peer conn is closed",
                            );

                            let removed_conn = {
                                let _update_guard = default_conn_update_lock_copy.lock();
                                let removed_conn = conns_copy.remove(&ret);
                                if let Some((_, conn)) = removed_conn.as_ref() {
                                    let cached_conn = default_conn_copy.load();
                                    if cached_conn
                                        .as_ref()
                                        .is_some_and(|cached| Arc::ptr_eq(cached, conn))
                                    {
                                        default_conn_copy.store(None);
                                    }
                                }
                                removed_conn
                            };

                            if let Some((_, conn)) = removed_conn {
                                context_copy.issue_event(PeerEvent::PeerConnRemoved(
                                    conn.get_conn_info(),
                                ));
                                shrink_dashmap(&conns_copy, Some(4));
                                if conns_copy.is_empty() {
                                    peer_identity_type_copy.store(None);
                                    *peer_public_key_copy.write() = None;
                                }
                            }
                        }

                        _ = shutdown_notifier_copy.notified() => {
                            close_event_receiver.close();
                            tracing::warn!(?peer_node_id, "peer close event listener notified");
                        }
                    }
                }
                tracing::info!("peer {} close event listener exit", peer_node_id);
            }
            .instrument(tracing::info_span!(
                "peer_close_event_listener",
                ?peer_node_id,
            )),
        ));

        let conns_copy = conns.clone();
        let default_conn_copy = default_conn.clone();
        let context_copy = context.clone();
        let default_conn_update_lock_copy = default_conn_update_lock.clone();
        let default_conn_clear_task = AbortOnDropHandle::new(tokio::spawn(async move {
            loop {
                crate::foundation::time::sleep(std::time::Duration::from_secs(5)).await;
                if conns_copy.len() > 1 {
                    let flags = context_copy.flags();
                    if flags.enable_ipv6 && flags.prefer_ipv6 {
                        let _update_guard = default_conn_update_lock_copy.lock();
                        if let Some(current) = default_conn_copy.load_full() {
                            let current_rank = preferred_key(&current).0;
                            if current.is_closed()
                                || conns_copy.iter().any(|entry| {
                                    !entry.value().is_closed()
                                        && preferred_key(entry.value()).0 < current_rank
                                })
                            {
                                default_conn_copy.store(None);
                            }
                        }
                    } else {
                        default_conn_copy.store(None);
                    }
                }
            }
        }));

        Peer {
            peer_node_id,
            conns,
            packet_recv_chan,
            context,

            close_event_sender,
            close_event_listener,

            shutdown_notifier,
            default_conn,
            default_conn_update_lock,
            peer_identity_type,
            peer_public_key,
            default_conn_clear_task,
        }
    }

    pub async fn add_peer_conn(&self, mut conn: PeerConn) -> Result<(), Error> {
        let conn_identity_type = conn.get_peer_identity_type();
        let peer_identity_type = self.peer_identity_type.load();
        if let Some(peer_identity_type) = peer_identity_type {
            if peer_identity_type != conn_identity_type {
                return Err(Error::SecretKeyError(format!(
                    "peer identity type mismatch. peer: {:?}, conn: {:?}",
                    peer_identity_type, conn_identity_type
                )));
            }
        } else {
            self.peer_identity_type.store(Some(conn_identity_type));
        }

        let close_notifier = conn.get_close_notifier();
        let conn_info = conn.get_conn_info();
        let conn_pubkey = conn_info.noise_remote_static_pubkey.clone();
        {
            let mut peer_pubkey = self.peer_public_key.write();
            if let Some(existing_pubkey) = peer_pubkey.as_ref() {
                if existing_pubkey != &conn_pubkey {
                    return Err(Error::SecretKeyError(format!(
                        "peer public key mismatch. peer_id: {}, existing_len: {}, new_len: {}",
                        self.peer_node_id,
                        existing_pubkey.len(),
                        conn_pubkey.len()
                    )));
                }
            } else {
                *peer_pubkey = Some(conn_pubkey);
            }
        }

        conn.start_recv_loop(self.packet_recv_chan.clone()).await;
        conn.start_pingpong();
        self.conns.insert(conn.get_conn_id(), Arc::new(conn));

        let close_event_sender = self.close_event_sender.clone();
        tokio::spawn(async move {
            let conn_id = close_notifier.get_conn_id();
            if let Some(mut waiter) = close_notifier.get_waiter().await {
                let _ = waiter.recv().await;
            }
            if let Err(e) = close_event_sender.send(conn_id).await {
                tracing::warn!(?conn_id, "failed to send close event: {}", e);
            }
        });

        self.context
            .issue_event(PeerEvent::PeerConnAdded(conn_info));
        Ok(())
    }

    fn select_conn(&self) -> Option<ArcPeerConn> {
        let _update_guard = self.default_conn_update_lock.lock();
        let flags = self.context.flags();
        if flags.enable_ipv6 && flags.prefer_ipv6 {
            let selected = self
                .conns
                .iter()
                .filter(|conn| !conn.value().is_closed())
                .min_by_key(|conn| (preferred_key(conn.value()), conn.key().as_u128()))
                .map(|conn| conn.value().clone());
            if let Some(current) = self.default_conn.load_full()
                && !current.is_closed()
                && selected
                    .as_ref()
                    .is_none_or(|next| preferred_key(&current).0 <= preferred_key(next).0)
            {
                // Keep a healthy connection within the same family. A smaller
                // ping fluctuation or another v6 connection must not move flows.
                return Some(current);
            }
            self.default_conn.store(selected.clone());
            return selected;
        }
        if let Some(conn) = self.default_conn.load_full() {
            return Some(conn);
        }

        // A zero latency on a hole-punched connection means the ping loop has not
        // confirmed liveness yet. Prefer any other connection, so a freshly admitted
        // hole-punched path cannot steal traffic before its first successful ping.
        let selected = self
            .conns
            .iter()
            .min_by_key(|conn| {
                conn_latency_sort_key(
                    conn.value().get_stats().latency_us,
                    conn.value().is_hole_punched(),
                )
            })
            .map(|conn| conn.value().clone());

        if let Some(conn) = selected.as_ref() {
            self.default_conn.store(Some(conn.clone()));
        }
        selected
    }

    pub async fn send_msg(&self, msg: ZCPacket) -> Result<(), Error> {
        let default_conn = self.default_conn.load();
        if let Some(conn) = default_conn.as_ref() {
            let flags = self.context.flags();
            if !(flags.enable_ipv6 && flags.prefer_ipv6 && conn.is_closed()) {
                conn.send_msg(msg).await?;
                return Ok(());
            }
        }
        drop(default_conn);

        let Some(conn) = self.select_conn() else {
            return Err(Error::PeerNoConnectionError(self.peer_node_id));
        };
        conn.send_msg(msg).await?;

        Ok(())
    }

    pub async fn close_peer_conn(&self, conn_id: &PeerConnId) -> Result<(), Error> {
        let has_key = self.conns.contains_key(conn_id);
        if !has_key {
            return Err(Error::NotFound);
        }
        self.close_event_sender.send(*conn_id).await.unwrap();
        Ok(())
    }

    pub async fn list_peer_conns(&self) -> Vec<PeerConnInfo> {
        let mut conns = vec![];
        for conn in self.conns.iter() {
            // do not lock here, otherwise it will cause dashmap deadlock
            conns.push(conn.clone());
        }

        let mut ret = Vec::new();
        for conn in conns {
            let info = conn.get_conn_info();
            if !info.is_closed {
                ret.push(info);
            } else {
                let conn_id = info.conn_id.parse().unwrap();
                let _ = self.close_peer_conn(&conn_id).await;
            }
        }
        ret
    }

    pub fn has_live_conns(&self) -> bool {
        self.conns.iter().any(|entry| !entry.value().is_closed())
    }

    pub fn has_directly_connected_conn(&self) -> bool {
        self.conns
            .iter()
            .any(|entry| !entry.value().is_closed() && !entry.value().is_hole_punched())
    }

    pub(crate) fn has_live_ipv6_connection(&self) -> bool {
        self.conns
            .iter()
            .any(|entry| !entry.value().is_closed() && entry.value().uses_ipv6_underlay())
    }

    pub(crate) fn has_direct_attached_conn(&self) -> bool {
        self.conns.iter().any(|entry| {
            let conn = entry.value();
            !conn.is_closed() && !conn.is_hole_punched() && conn.is_attached()
        })
    }

    pub fn get_directly_connections(&self) -> DashSet<uuid::Uuid> {
        self.conns
            .iter()
            .filter(|entry| !(entry.value()).is_hole_punched())
            .map(|entry| (entry.value()).get_conn_id())
            .collect()
    }

    pub fn get_default_conn_id(&self) -> PeerConnId {
        self.default_conn
            .load()
            .as_ref()
            .map(|conn| conn.get_conn_id())
            .unwrap_or_default()
    }

    pub fn get_peer_identity_type(&self) -> Option<PeerIdentityType> {
        self.peer_identity_type.load()
    }

    pub fn get_peer_public_key(&self) -> Option<Vec<u8>> {
        self.peer_public_key.read().clone()
    }
}

// pritn on drop
impl Drop for Peer {
    fn drop(&mut self) {
        self.conns.retain(|_, conn| {
            self.context
                .issue_event(PeerEvent::PeerConnRemoved(conn.get_conn_info()));
            false
        });
        self.shutdown_notifier.notify_one();
        tracing::info!("peer {} drop", self.peer_node_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        peers::{
            conn::peer_session::PeerSessionStore, create_packet_recv_chan,
            test_support::NoopPeerContext,
        },
        proto::common::{FlagsInConfig, TunnelInfo},
        tunnel::{SplitTunnel, Tunnel, ring::create_ring_tunnel_pair},
    };

    struct AddressedTunnel {
        inner: Box<dyn Tunnel>,
        info: TunnelInfo,
    }

    impl Tunnel for AddressedTunnel {
        fn split(&self) -> SplitTunnel {
            self.inner.split()
        }
        fn info(&self) -> Option<TunnelInfo> {
            Some(self.info.clone())
        }
    }

    async fn connection_pair(context: ArcPeerContext, endpoint: &str) -> (PeerConn, PeerConn) {
        let (client, server) = create_ring_tunnel_pair();
        let sessions = Arc::new(PeerSessionStore::new());
        let mut client = PeerConn::new(
            1,
            context.clone(),
            Box::new(AddressedTunnel {
                inner: client,
                info: TunnelInfo {
                    remote_addr: Some(endpoint.parse::<url::Url>().unwrap().into()),
                    ..Default::default()
                },
            }),
            sessions.clone(),
        );
        let mut server = PeerConn::new(2, context, server, sessions);
        let (a, b) = tokio::join!(
            client.do_handshake_as_client(),
            server.do_handshake_as_server_ext(|_, _| Ok(())),
        );
        a.unwrap();
        b.unwrap();
        (client, server)
    }

    #[tokio::test]
    async fn preferred_cache_upgrades_verified_ipv6_and_falls_back_without_removing_ipv4() {
        let context: ArcPeerContext =
            Arc::new(NoopPeerContext::default().with_flags(FlagsInConfig {
                enable_ipv6: true,
                prefer_ipv6: true,
                ..Default::default()
            }));
        let (client_tx, _client_rx) = create_packet_recv_chan();
        let (server_tx, _server_rx) = create_packet_recv_chan();
        let client = Peer::new(2, client_tx, context.clone());
        let server = Peer::new(1, server_tx, context.clone());

        let (v4, remote_v4) = connection_pair(context.clone(), "tcp://192.0.2.1:22020").await;
        let v4_id = v4.get_conn_id();
        v4.record_test_latency(10);
        client.add_peer_conn(v4).await.unwrap();
        server.add_peer_conn(remote_v4).await.unwrap();
        assert_eq!(client.select_conn().unwrap().get_conn_id(), v4_id);

        let (v6, remote_v6) = connection_pair(context.clone(), "tcp://[2001:db8::1]:22020").await;
        let v6_id = v6.get_conn_id();
        client.add_peer_conn(v6).await.unwrap();
        server.add_peer_conn(remote_v6).await.unwrap();
        assert_eq!(
            client.select_conn().unwrap().get_conn_id(),
            v4_id,
            "unverified IPv6 must not steal an established IPv4 flow"
        );
        // A measured zero is valid. Readiness must use the sample count, not
        // assume that zero microseconds means the ping loop has never succeeded.
        client.conns.get(&v6_id).unwrap().record_test_latency(0);
        assert_eq!(client.select_conn().unwrap().get_conn_id(), v6_id);
        client
            .conns
            .get(&v6_id)
            .unwrap()
            .record_test_latency(60_000);

        let (faster_v6, remote_faster_v6) =
            connection_pair(context, "tcp://[2001:db8::2]:22020").await;
        let faster_id = faster_v6.get_conn_id();
        faster_v6.record_test_latency(1);
        client.add_peer_conn(faster_v6).await.unwrap();
        server.add_peer_conn(remote_faster_v6).await.unwrap();
        assert_eq!(
            client.select_conn().unwrap().get_conn_id(),
            v6_id,
            "a lower-latency path within the same family must not churn the cache"
        );

        for (removed, expected) in [(v6_id, faster_id), (faster_id, v4_id)] {
            client.close_peer_conn(&removed).await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while client.conns.contains_key(&removed) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(client.select_conn().unwrap().get_conn_id(), expected);
        }
        assert!(client.conns.contains_key(&v4_id));
    }

    #[test]
    fn verified_ipv6_precedes_lower_latency_ipv4_only_when_preferred() {
        assert!(
            preferred_conn_sort_key(90_000, false, true, true)
                < preferred_conn_sort_key(10, false, false, true)
        );
        assert!(conn_latency_sort_key(10, false) < conn_latency_sort_key(90_000, false));
        assert!(
            preferred_conn_sort_key(10, false, false, true)
                < preferred_conn_sort_key(0, false, true, false)
        );
    }

    #[test]
    fn measured_relay_precedes_unverified_hole_punch_path() {
        assert!(conn_latency_sort_key(20_000, false) < conn_latency_sort_key(0, true));
    }

    #[test]
    fn unmeasured_regular_connection_keeps_existing_priority() {
        assert!(conn_latency_sort_key(0, false) < conn_latency_sort_key(20_000, false));
    }

    #[test]
    fn verified_lower_latency_path_can_be_preferred() {
        assert!(conn_latency_sort_key(5_000, true) < conn_latency_sort_key(20_000, false));
    }
}
