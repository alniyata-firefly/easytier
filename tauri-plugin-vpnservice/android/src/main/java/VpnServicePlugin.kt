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
    var requestId: String? = null
    var instanceId: String? = null
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
            val it = VpnService.prepare(activity)
            val ret = JSObject()
            if (it != null) {
                ret.put("errorMsg", "need_prepare")
            } else {
                // Old callers may omit these fields. New clients always supply
                // both and match the authoritative snapshot before using a fd.
                val requestId = args.requestId ?: java.util.UUID.randomUUID().toString()
                val instanceId = args.instanceId ?: "legacy"
                if (!TauriVpnService.beginStart(requestId, instanceId)) {
                    ret.put("errorMsg", "vpn_service_busy")
                    invoke.resolve(ret)
                    return@runOnUiThread
                }
                val intent = Intent(activity, TauriVpnService::class.java)
                intent.putExtra(TauriVpnService.REQUEST_ID, requestId)
                intent.putExtra(TauriVpnService.INSTANCE_ID, instanceId)
                intent.putExtra(TauriVpnService.IPV4_ADDR, args.ipv4Addr)
                intent.putExtra(TauriVpnService.ROUTES, args.routes)
                intent.putExtra(TauriVpnService.DNS, args.dns)
                intent.putExtra(TauriVpnService.DISALLOWED_APPLICATIONS, args.disallowedApplications)
                intent.putExtra(TauriVpnService.MTU, args.mtu)

                try {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        activity.startForegroundService(intent)
                    } else {
                        activity.startService(intent)
                    }
                } catch (_: Exception) {
                    TauriVpnService.startRejected(requestId, "vpn_foreground_start_failed")
                    ret.put("errorMsg", "vpn_foreground_start_failed")
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
                val ret = JSObject()
                ret.put("errorMsg", if (args.enabled) "client_foreground_start_failed" else "client_foreground_stop_failed")
                invoke.resolve(ret)
            }
        }
    }

    @Command
    fun stopVpn(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                TauriVpnService.requestStop(activity)
                invoke.resolve(JSObject())
            } catch (_: Exception) {
                val ret = JSObject()
                ret.put("errorMsg", "vpn_stop_failed")
                invoke.resolve(ret)
            }
        }
    }

    @Command
    fun getVpnStatus(invoke: Invoke) {
        activity.runOnUiThread { invoke.resolve(TauriVpnService.statusSnapshot()) }
    }

    @Command
    fun consumeVpnTileAction(invoke: Invoke) {
        val ret = JSObject()
        ret.put("action", EasyTierVpnTileService.consumePendingAction(activity))
        invoke.resolve(ret)
    }
}
