use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct NativeStopListener {
    event: &'static str,
    handler: tauri::ipc::Channel<VpnStatus>,
}

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.plugin.vpnservice";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_vpnservice);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Vpnservice<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VpnServicePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_vpnservice)?;
    Ok(Vpnservice(handle))
}

/// Access to the vpnservice APIs.
pub struct Vpnservice<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Vpnservice<R> {
    pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
        self.0
            .run_mobile_plugin("ping", payload)
            .map_err(Into::into)
    }

    pub fn prepare_vpn(&self, payload: VoidRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("prepareVpn", payload)
            .map_err(Into::into)
    }

    pub fn start_vpn(&self, payload: StartVpnRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("startVpn", payload)
            .map_err(Into::into)
    }

    pub fn stop_vpn(&self, payload: VoidRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("stopVpn", payload)
            .map_err(Into::into)
    }

    pub fn set_client_enabled(&self, payload: SetClientEnabledRequest) -> crate::Result<Status> {
        self.0
            .run_mobile_plugin("setClientEnabled", payload)
            .map_err(Into::into)
    }

    pub fn get_vpn_status(&self, payload: VoidRequest) -> crate::Result<VpnStatus> {
        self.0
            .run_mobile_plugin("getVpnStatus", payload)
            .map_err(Into::into)
    }

    /// Receives service destruction directly in Rust, without a live WebView
    /// JavaScript listener. The callback must not block Android's main thread.
    #[cfg(target_os = "android")]
    pub fn register_native_stop_listener(
        &self,
        callback: impl Fn(VpnStatus) + Send + Sync + 'static,
    ) -> crate::Result<()> {
        use tauri::ipc::Channel;

        let handler = Channel::<VpnStatus>::new(move |body| {
            // A malformed or intermediate payload must never cancel an owner.
            if let Ok(status) = body.deserialize::<VpnStatus>() {
                if !status.running && status.state.as_deref() == Some("stopped") {
                    callback(status);
                }
            }
            Ok(())
        });
        self.0
            .run_mobile_plugin::<Option<Status>>(
                "registerListener",
                NativeStopListener {
                    event: "vpn_service_stop",
                    handler,
                },
            )
            .map(|_| ())
            .map_err(Into::into)
    }

    pub fn consume_vpn_tile_action(
        &self,
        payload: VoidRequest,
    ) -> crate::Result<VpnTileActionResponse> {
        self.0
            .run_mobile_plugin("consumeVpnTileAction", payload)
            .map_err(Into::into)
    }
}
