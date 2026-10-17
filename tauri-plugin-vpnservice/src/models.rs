#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingRequest {
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidRequest {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetClientEnabledRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVpnRequest {
    pub request_id: Option<String>,
    pub instance_id: Option<String>,
    pub ipv4_addr: Option<String>,
    pub routes: Option<Vec<String>>,
    pub dns: Option<String>,
    pub disallowed_applications: Option<Vec<String>>,
    pub mtu: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub error_msg: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnStatus {
    pub running: bool,
    pub state: Option<String>,
    pub request_id: Option<String>,
    pub instance_id: Option<String>,
    pub established: Option<bool>,
    pub fd: Option<i32>,
    pub error_msg: Option<String>,
    pub stop_reason: Option<String>,
    pub ipv4_addr: Option<String>,
    pub routes: Option<Vec<String>>,
    pub dns: Option<String>,
}

impl VpnStatus {
    pub(crate) fn is_native_stop_notification(&self) -> bool {
        (!self.running && self.state.as_deref() == Some("stopped"))
            || (self.stop_reason.as_deref() == Some("system_revoked")
                && self.state.as_deref() == Some("stopping")
                && self.established != Some(true))
    }
}

#[cfg(test)]
mod tests {
    use super::VpnStatus;

    #[test]
    fn stop_notifications_accept_early_system_revocation_but_not_normal_transitions() {
        let mut snapshot = VpnStatus {
            running: true,
            state: Some("stopping".to_owned()),
            established: Some(false),
            ..Default::default()
        };
        assert!(!snapshot.is_native_stop_notification());
        snapshot.stop_reason = Some("system_revoked".to_owned());
        assert!(snapshot.is_native_stop_notification());
        snapshot.established = Some(true);
        assert!(!snapshot.is_native_stop_notification());
        snapshot.state = Some("established".to_owned());
        assert!(!snapshot.is_native_stop_notification());
        snapshot.state = Some("stopped".to_owned());
        snapshot.running = false;
        snapshot.established = Some(false);
        snapshot.stop_reason = None;
        assert!(snapshot.is_native_stop_notification());
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VpnTileActionResponse {
    pub action: Option<String>,
}
