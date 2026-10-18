package com.plugin.vpnservice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.Context
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.content.pm.ServiceInfo
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import java.net.InetAddress
import java.util.Arrays

import app.tauri.plugin.JSObject
import org.json.JSONArray

class TauriVpnService : VpnService() {
    companion object {
        @JvmField var triggerCallback: (String, JSObject) -> Unit = { _, _ -> }
        @JvmField var self: TauriVpnService? = null
        @JvmField var ipv4Addr: String? = null
        @JvmField var routes: Array<String> = emptyArray()
        @JvmField var dns: String? = null

        const val IPV4_ADDR = "IPV4_ADDR"
        const val ROUTES = "ROUTES"
        const val DNS = "DNS"
        const val DISALLOWED_APPLICATIONS = "DISALLOWED_APPLICATIONS"
        const val MTU = "MTU"
        const val REQUEST_ID = "REQUEST_ID"
        const val INSTANCE_ID = "INSTANCE_ID"

        // All transitions and snapshots run on Android's main thread. A queued
        // start/stop receipt is not proof that the service established/exited.
        private var state = "stopped"
        private var requestId: String? = null
        private var instanceId: String? = null
        private var establishedFd: Int? = null
        private var errorMsg: String? = null
        private var stopReason: String? = null

        fun beginStart(request: String, instance: String): Boolean {
            if (state != "stopped" || self != null) return false
            requestId = request
            instanceId = instance
            errorMsg = null
            stopReason = null
            establishedFd = null
            state = "starting"
            return true
        }

        fun startRejected(request: String, error: String) {
            if (requestId != request) return
            errorMsg = error
            if (self == null) state = "stopped"
        }

        fun requestStop(context: Context) {
            if (state == "stopped" && self == null) return
            state = "stopping"
            establishedFd = null
            self?.closeTunnel()
            val stopping = context.stopService(Intent(context, TauriVpnService::class.java))
            // false with no service also covers an already cancelled pending
            // start. A real service is acknowledged only by onDestroy.
            if (!stopping && self == null) state = "stopped"
        }

        fun statusSnapshot(): JSObject = JSObject().also {
            it.put("state", state)
            it.put("running", state != "stopped")
            it.put("requestId", requestId)
            it.put("instanceId", instanceId)
            it.put("established", state == "established" && establishedFd != null)
            it.put("fd", if (state == "established") establishedFd else null)
            it.put("errorMsg", errorMsg)
            it.put("stopReason", stopReason)
            it.put("ipv4Addr", ipv4Addr)
            it.put("routes", JSONArray(routes.toList()))
            it.put("dns", dns)
        }

        private const val NOTIFICATION_CHANNEL_ID = "easytier_vpn_channel"
        private const val NOTIFICATION_ID = 1356

        // This preference controls management keepalive; Rust owns the VPN/TUN switch.
        private const val CLIENT_PREFERENCES = "easytier_client_lifecycle"
        private const val CLIENT_ENABLED = "enabled"

        fun isClientEnabled(context: Context): Boolean =
            context.getSharedPreferences(CLIENT_PREFERENCES, Context.MODE_PRIVATE)
                .getBoolean(CLIENT_ENABLED, false)

        fun clientForegroundPolicy(context: Context): ClientForegroundPolicy =
            ClientForegroundPolicy(
                readEnabled = { isClientEnabled(context) },
                writeEnabled = { enabled ->
                    context.getSharedPreferences(CLIENT_PREFERENCES, Context.MODE_PRIVATE)
                        .edit().putBoolean(CLIENT_ENABLED, enabled).apply()
                },
                updateService = { enabled -> updateMainForegroundService(context, enabled) },
                readVpnRunning = { self?.foregroundActive == true },
            )

        private fun updateMainForegroundService(context: Context, enabled: Boolean) {
            val services = context.packageManager
                .getPackageInfo(context.packageName, PackageManager.GET_SERVICES)
                .services.orEmpty()
                .filter { it.name?.substringAfterLast('.') == "MainForegroundService" }
            check(services.size == 1) {
                "Expected exactly one MainForegroundService in the application manifest"
            }
            val intent = Intent().setClassName(context.packageName, services.single().name)
            if (!enabled) {
                context.stopService(intent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var foregroundActive = false
    private var ownedRequestId: String? = null
    private var ownedInstanceId: String? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val request = intent?.getStringExtra(REQUEST_ID)
        val instance = intent?.getStringExtra(INSTANCE_ID)
        if (request == null || instance == null || request != requestId || instance != instanceId
            || state != "starting") {
            // Reject cancelled/old intents. Do not revoke a newer established
            // owner merely because an old queued intent was delivered late.
            if (state == "stopped" || state == "stopping") {
                state = "stopping"
                stopSelf()
            }
            return START_NOT_STICKY
        }
        ownedRequestId = request
        ownedInstanceId = instance
        var failureStage = "vpn_foreground_start_failed"
        try {
            startVpnForegroundService()
            failureStage = "vpn_tun_start_failed"
            val args = intent?.extras
            ipv4Addr = args?.getString(IPV4_ADDR)
            routes = args?.getStringArray(ROUTES) ?: emptyArray()
            dns = args?.getString(DNS)
            val descriptor = createVpnInterface(args)
            vpnInterface = descriptor
            establishedFd = descriptor.fd
            state = "established"
            triggerCallback("vpn_service_start", statusSnapshot())
            EasyTierVpnTileService.requestStateUpdate(this)
            return START_STICKY
        } catch (_: Exception) {
            errorMsg = failureStage
            state = "stopping"
            closeTunnel()
            stopForeground(STOP_FOREGROUND_REMOVE)
            foregroundActive = false
            stopSelf()
            return START_NOT_STICKY
        }
    }

    override fun onCreate() {
        super.onCreate()
        self = this
        println("vpn on create")
    }

    override fun onDestroy() {
        closeTunnel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundActive = false
        if (self === this) {
            self = null
            establishedFd = null
            state = "stopped"
            clearStatus()
            try {
                clientForegroundPolicy(this).onVpnChanged(false)
            } catch (_: Exception) {
                if (errorMsg == null) errorMsg = "client_foreground_start_failed"
            }
            triggerCallback("vpn_service_stop", statusSnapshot())
        }
        EasyTierVpnTileService.requestStateUpdate(this)
        super.onDestroy()
    }

    override fun onRevoke() {
        // Android may deliver revocation on a Binder thread. Serialize it with
        // start, stop and status snapshots before touching the shared owner.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            revokeOnMain()
        } else {
            Handler(Looper.getMainLooper()).post { revokeOnMain() }
        }
    }

    private fun revokeOnMain() {
        // Called by Android, never manually by the plugin. Keep self until
        // onDestroy so getVpnStatus cannot acknowledge an incomplete stop.
        val revokedCurrent = self === this
        if (revokedCurrent) {
            state = "stopping"
            stopReason = "system_revoked"
        }
        closeTunnel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundActive = false
        try {
            // Publish before onDestroy so an in-flight route update cannot
            // recreate a VPN whose permission Android has just revoked.
            if (revokedCurrent) triggerCallback("vpn_service_stop", statusSnapshot())
        } finally {
            stopSelf()
            super.onRevoke()
        }
    }

    private fun closeTunnel() {
        val descriptor = vpnInterface
        vpnInterface = null
        if (self === this && ownedRequestId == requestId && ownedInstanceId == instanceId) {
            establishedFd = null
        }
        try {
            descriptor?.close()
        } catch (_: Exception) {
            if (self === this) errorMsg = "vpn_stop_failed"
        }
    }

    private fun clearStatus() {
        ipv4Addr = null
        routes = emptyArray()
        dns = null
    }

    private fun startVpnForegroundService() {
        createNotificationChannel()

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.vpn_tile_icon)
            .setContentTitle("EasyTier VPN is running")
            .setContentText("VPN connection is active")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .apply { contentIntent?.let(::setContentIntent) }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        foregroundActive = true
        // A TUN-backed network is now protected by this foreground service, so the
        // no-TUN keepalive service is redundant and would show a second notification.
        clientForegroundPolicy(this).onVpnChanged(true)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "EasyTier VPN",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun createVpnInterface(args: Bundle?): ParcelFileDescriptor {
        var builder = Builder()
                .setSession("EasyTier")
                .setBlocking(false)
        
        var mtu = args?.getInt(MTU) ?: 1500
        var ipv4Addr = args?.getString(IPV4_ADDR) ?: "10.126.126.1/24"
        var dns: String? = args?.getString(DNS)
        var routes = args?.getStringArray(ROUTES) ?: emptyArray()
        var disallowedApplications = args?.getStringArray(DISALLOWED_APPLICATIONS) ?: emptyArray()

        println("vpn create vpn interface. mtu: $mtu, ipv4Addr: $ipv4Addr, dns:" +
            "$dns, routes: ${java.util.Arrays.toString(routes)}," +
            "disallowedApplications:  ${java.util.Arrays.toString(disallowedApplications)}")

        val ipParts = ipv4Addr.split("/")
        if (ipParts.size != 2) throw IllegalArgumentException("Invalid IP addr string")
        builder.addAddress(ipParts[0], ipParts[1].toInt())
        builder.addAddress("fd00::1", 128)

        builder.setMtu(mtu)
        dns?.let { builder.addDnsServer(it) }

        for (route in routes) {
            val ipParts = route.split("/")
            if (ipParts.size != 2) throw IllegalArgumentException("Invalid route cidr string")
            builder.addRoute(ipParts[0], ipParts[1].toInt())
        }
        
        // The installed application ID can differ from the Kotlin namespace
        // (for example a separately signed build). Always bypass this VPN for
        // our own tunnel sockets using the native runtime identity.
        for (app in (disallowedApplications.toList() + packageName).distinct()) {
            try {
                builder.addDisallowedApplication(app)
            } catch (_: PackageManager.NameNotFoundException) {
                // An optional excluded application may have been uninstalled;
                // it cannot produce VPN traffic and must not prevent startup.
                android.util.Log.w("EasyTierVpn", "Skipping an unavailable excluded application")
            }
        }

        return builder.also {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                it.setMetered(false)
            }
        }
        .establish()
        ?: throw IllegalStateException("Failed to init VpnService")
    }
}
