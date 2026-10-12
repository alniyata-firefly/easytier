use std::fmt::{Display, Formatter};

use uuid::Uuid;

use crate::{
    common::{
        global_ctx::{EventBusSubscriber, GlobalCtxEvent},
        log,
    },
    proto,
};

struct DisplayPeerConnInfo<'a>(&'a proto::api::instance::PeerConnInfo);

impl Display for DisplayPeerConnInfo<'_> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let mut tunnel = self.0.tunnel.clone();
        if let Some(tunnel) = tunnel.as_mut() {
            for endpoint in [
                &mut tunnel.local_addr,
                &mut tunnel.remote_addr,
                &mut tunnel.resolved_remote_addr,
            ]
            .into_iter()
            .flatten()
            {
                endpoint.url = safe_endpoint_text(&endpoint.url);
            }
        }
        formatter
            .debug_struct("PeerConnInfo")
            .field("my_peer_id", &self.0.my_peer_id)
            .field("dst_peer_id", &self.0.peer_id)
            .field("tunnel_info", &tunnel)
            .finish()
    }
}

fn safe_endpoint_text(value: &str) -> String {
    url::Url::parse(value)
        .map(|url| easytier_core::connectivity::manual::redacted_endpoint_url(&url).to_string())
        .unwrap_or_else(|_| "<invalid endpoint>".to_owned())
}

macro_rules! event {
    ($lvl:ident, category: $cat:expr, $($args:tt)+) => {
        event!(@impl $lvl, concat!("INSTANCE::", $cat), $($args)+)
    };

    ($lvl:ident, $($args:tt)+) => {
        event!(@impl $lvl, "INSTANCE", $($args)+)
    };

    (@impl $lvl:ident, $cat:expr, $($args:tt)+) => {
        log::$lvl!(
            category: $cat,
            $($args)+
        );
    };
}

pub(super) fn spawn(instance_id: Uuid, events: EventBusSubscriber) {
    drop(tokio::spawn(log_events(instance_id, events)));
}

async fn log_events(instance_id: Uuid, mut events: EventBusSubscriber) {
    loop {
        match events.recv().await {
            Ok(event) => log_event(instance_id, event),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
        }
    }
}

fn log_event(instance_id: Uuid, event: GlobalCtxEvent) {
    match event {
        GlobalCtxEvent::PeerAdded(peer_id) => {
            event!(info, peer_id, "[{}] new peer added", instance_id);
        }
        GlobalCtxEvent::PeerRemoved(peer_id) => {
            event!(info, peer_id, "[{}] peer removed", instance_id);
        }
        GlobalCtxEvent::PeerConnAdded(conn_info) => {
            let conn_info = DisplayPeerConnInfo(&conn_info);
            event!(
                info,
                category: "CONNECTION",
                %conn_info,
                "[{}] new peer connection added",
                instance_id,
            );
        }
        GlobalCtxEvent::PeerConnRemoved(conn_info) => {
            let conn_info = DisplayPeerConnInfo(&conn_info);
            event!(
                info,
                category: "CONNECTION",
                %conn_info,
                "[{}] peer connection removed",
                instance_id,
            );
        }
        GlobalCtxEvent::ListenerAddFailed(listener, msg) => {
            event!(warn, %listener, msg, "[{}] listener add failed", instance_id);
        }
        GlobalCtxEvent::ListenerAcceptFailed(listener, msg) => {
            event!(warn, %listener, msg, "[{}] listener accept failed", instance_id);
        }
        GlobalCtxEvent::ListenerAdded(listener) => {
            if listener.scheme() == "ring" {
                return;
            }
            event!(
                info,
                %listener,
                "[{}] new listener added",
                instance_id
            );
        }
        GlobalCtxEvent::ConnectionAccepted(local, remote) => {
            event!(
                info,
                category: "CONNECTION",
                local,
                remote,
                "[{}] new connection accepted",
                instance_id
            );
        }
        GlobalCtxEvent::ConnectionError(local, remote, err) => {
            event!(
                info,
                category: "CONNECTION",
                local,
                remote,
                err,
                "[{}] connection error",
                instance_id
            );
        }
        GlobalCtxEvent::ListenerPortMappingEstablished {
            local_listener,
            mapped_listener,
            backend,
        } => {
            event!(
                info,
                %local_listener,
                %mapped_listener,
                backend,
                "[{}] listener port mapping established",
                instance_id
            );
        }
        GlobalCtxEvent::TunDeviceReady(dev) => {
            event!(info, dev, "[{}] tun device ready", instance_id);
        }
        GlobalCtxEvent::TunDeviceError(err) => {
            event!(error, %err, "[{}] tun device error", instance_id);
        }
        GlobalCtxEvent::Connecting(dst) => {
            let dst = easytier_core::connectivity::manual::redacted_endpoint_url(&dst);
            event!(
                info,
                category: "CONNECTION",
                %dst,
                "[{}] connecting to peer",
                instance_id
            );
        }
        GlobalCtxEvent::ConnectError(dst, ip_version, error) => {
            let dst = safe_endpoint_text(&dst);
            event!(
                info,
                category: "CONNECTION",
                dst,
                ip_version,
                %error,
                "[{}] connect to peer error",
                instance_id
            );
        }
        GlobalCtxEvent::VpnPortalStarted(portal) => {
            event!(info, portal, "[{}] vpn portal started", instance_id);
        }
        GlobalCtxEvent::VpnPortalClientConnected(portal, client_addr) => {
            event!(
                info,
                portal,
                client_addr,
                "[{}] vpn portal client connected",
                instance_id
            );
        }
        GlobalCtxEvent::VpnPortalClientDisconnected(portal, client_addr) => {
            event!(
                info,
                portal,
                client_addr,
                "[{}] vpn portal client disconnected",
                instance_id
            );
        }
        GlobalCtxEvent::DhcpIpv4Changed(old, new) => {
            event!(info, ?old, ?new, "[{}] dhcp ip changed", instance_id);
        }
        GlobalCtxEvent::DhcpIpv4Conflicted(ip) => {
            event!(info, ?ip, "[{}] dhcp ip conflict", instance_id);
        }
        GlobalCtxEvent::PublicIpv6Changed(old, new) => {
            event!(info, ?old, ?new, "[{}] public ipv6 changed", instance_id);
        }
        GlobalCtxEvent::PublicIpv6RoutesUpdated(added, removed) => {
            event!(
                info,
                ?added,
                ?removed,
                "[{}] public ipv6 routes updated",
                instance_id
            );
        }
        GlobalCtxEvent::PortForwardAdded(cfg) => {
            event!(
                info,
                local = %cfg.bind_addr.unwrap(),
                remote = %cfg.dst_addr.unwrap(),
                proto = %cfg.socket_type().as_str_name(),
                "[{}] port forward added",
                instance_id,
            );
        }
        #[cfg(feature = "management")]
        GlobalCtxEvent::ConfigPatched(patch) => {
            event!(info, ?patch, "[{}] config patched", instance_id);
        }
        GlobalCtxEvent::ProxyCidrsUpdated(added, removed) => {
            event!(
                info,
                ?added,
                ?removed,
                "[{}] proxy CIDRs updated",
                instance_id
            );
        }
        GlobalCtxEvent::UdpBroadcastRelayStartResult {
            capture_backend,
            error,
        } => {
            if let Some(error) = error {
                event!(
                    warn,
                    ?capture_backend,
                    %error,
                    "[{}] UDP broadcast relay start failed",
                    instance_id
                );
            } else {
                event!(
                    info,
                    ?capture_backend,
                    "[{}] UDP broadcast relay started",
                    instance_id
                );
            }
        }
        GlobalCtxEvent::CredentialChanged => {
            event!(info, "[{}] credential changed", instance_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::broadcast;

    use super::*;

    #[test]
    fn connection_events_redact_every_endpoint_without_mutating_the_connection() {
        let secret = "device-management-token-should-never-be-logged";
        let endpoint = proto::common::Url {
            url: format!("wss://user:{secret}@vpn.example.test/config/{secret}?token={secret}"),
        };
        let connection = proto::api::instance::PeerConnInfo {
            my_peer_id: 10,
            peer_id: 20,
            tunnel: Some(proto::common::TunnelInfo {
                tunnel_type: "wss".to_string(),
                local_addr: Some(endpoint.clone()),
                remote_addr: Some(endpoint.clone()),
                resolved_remote_addr: Some(endpoint.clone()),
            }),
            ..Default::default()
        };
        let rendered = DisplayPeerConnInfo(&connection).to_string();
        assert!(!rendered.contains(secret));
        assert!(rendered.contains("vpn.example.test"));
        assert!(rendered.contains("20"));
        assert_eq!(
            connection.tunnel.unwrap().resolved_remote_addr,
            Some(endpoint)
        );
        assert_eq!(
            safe_endpoint_text("invalid URL with secret"),
            "<invalid endpoint>"
        );
    }

    #[tokio::test]
    async fn event_loop_stops_when_the_instance_closes() {
        let (sender, events) = broadcast::channel(1);
        let task = tokio::spawn(log_events(Uuid::new_v4(), events));

        sender.send(GlobalCtxEvent::CredentialChanged).unwrap();
        drop(sender);
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
    }
}
