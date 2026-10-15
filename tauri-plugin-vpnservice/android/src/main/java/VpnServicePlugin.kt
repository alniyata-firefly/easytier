package com.plugin.vpnservice

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import androidx.activity.result.ActivityResult
import app.tauri.annotation.Command
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.webkit.WebView

@InvokeArg
class PingArgs {
    var value: String? = null
}

@InvokeArg
class StartVpnArgs {
    var ipv4Addr: String? = null
    var routes: Array<String> = emptyArray()
    var dns: String? = null
    var disallowedApplications: Array<String> = emptyArray()
    var mtu: Int? = null
}

@InvokeArg
class SetClientEnabledArgs {
    var enabled: Boolean = false
}

@TauriPlugin
class VpnServicePlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        @Volatile
        private var tileActionCallback: (String) -> Boolean = { false }

        fun dispatchTileAction(action: String): Boolean = tileActionCallback(action)
    }

    private val implementation = Example()
    private val tileActionHandler: (String) -> Boolean = { action ->
        val data = JSObject()
        data.put("action", action)
        trigger("vpn_tile_action", data)
        true
    }

    override fun load(webView: WebView) {
        println("load vpn service plugin")
        TauriVpnService.triggerCallback = { event, data ->
            println("vpn: triggerCallback $event $data")
            trigger(event, data)
        }
        tileActionCallback = tileActionHandler
    }

    override fun onDestroy() {
        if (tileActionCallback === tileActionHandler) {
            tileActionCallback = { false }
        }
        super.onDestroy()
    }

    @Command
    fun ping(invoke: Invoke) {
        val args = invoke.parseArgs(PingArgs::class.java)

        val ret = JSObject()
        ret.put("value", implementation.pong(args.value ?: "default value :("))
        invoke.resolve(ret)
    }

    @Command
    fun prepareVpn(invoke: Invoke) {
        activity.runOnUiThread {
            println("prepare vpn in plugin")
            val it = VpnService.prepare(activity)
            if (it != null) {
                startActivityForResult(invoke, it, "onPrepareVpnResult")
                return@runOnUiThread
            }
            val ret = JSObject()
            ret.put("granted", true)
            invoke.resolve(ret)
        }
    }

    @ActivityCallback
    fun onPrepareVpnResult(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        ret.put("granted", result.resultCode == Activity.RESULT_OK)
        invoke.resolve(ret)
    }

    @Command
    fun startVpn(invoke: Invoke) {
        val args = invoke.parseArgs(StartVpnArgs::class.java)
        activity.runOnUiThread {
            if (!TauriVpnService.isClientEnabled(activity)) {
                val ret = JSObject()
                ret.put("errorMsg", "client_paused")
                invoke.resolve(ret)
                return@runOnUiThread
            }
            println("start vpn in plugin, args: $args")

            TauriVpnService.self?.onRevoke()

            val it = VpnService.prepare(activity)
            val ret = JSObject()
            if (it != null) {
                ret.put("errorMsg", "need_prepare")
            } else {
                val intent = Intent(activity, TauriVpnService::class.java)
                intent.putExtra(TauriVpnService.IPV4_ADDR, args.ipv4Addr)
                intent.putExtra(TauriVpnService.ROUTES, args.routes)
                intent.putExtra(TauriVpnService.DNS, args.dns)
                intent.putExtra(TauriVpnService.DISALLOWED_APPLICATIONS, args.disallowedApplications)
                intent.putExtra(TauriVpnService.MTU, args.mtu)

                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    activity.startForegroundService(intent)
                } else {
                    activity.startService(intent)
                }
            }
            invoke.resolve(ret)
        }
    }

    @Command
    fun setClientEnabled(invoke: Invoke) {
        val args = invoke.parseArgs(SetClientEnabledArgs::class.java)
        activity.runOnUiThread {
            try {
                TauriVpnService.clientForegroundPolicy(activity).setEnabled(args.enabled)
                invoke.resolve(JSObject())
            } catch (_: Exception) {
                invoke.reject("Failed to update the client background service")
            }
        }
    }

    @Command
    fun stopVpn(invoke: Invoke) {
        activity.runOnUiThread {
            println("stop vpn in plugin")
            var failed = false
            try {
                TauriVpnService.self?.onRevoke()
            } catch (_: Exception) {
                failed = true
            }
            try {
                activity.stopService(Intent(activity, TauriVpnService::class.java))
            } catch (_: Exception) {
                failed = true
            }
            if (failed) invoke.reject("Failed to stop the Android VPN service")
            else invoke.resolve(JSObject())
        }
    }

    @Command
    fun getVpnStatus(invoke: Invoke) {
        val ret = JSObject()
        ret.put("running", TauriVpnService.self != null)
        ret.put("ipv4Addr", TauriVpnService.ipv4Addr)
        ret.put("routes", TauriVpnService.routes)
        ret.put("dns", TauriVpnService.dns)
        invoke.resolve(ret)
    }

    @Command
    fun consumeVpnTileAction(invoke: Invoke) {
        val ret = JSObject()
        ret.put("action", EasyTierVpnTileService.consumePendingAction(activity))
        invoke.resolve(ret)
    }
}
