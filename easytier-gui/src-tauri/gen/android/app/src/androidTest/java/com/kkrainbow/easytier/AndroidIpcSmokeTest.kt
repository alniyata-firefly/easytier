package com.kkrainbow.easytier

import android.Manifest
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Executes the real embedded test document in the application's actual Tauri WebView. */
@RunWith(AndroidJUnit4::class)
class AndroidIpcSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val webView = AtomicReference<WebView>()

    class Observer(private val destination: File) {
        private var current = JSONObject().put("status", "not_started")
        private val system = JSONArray()
        private val gui = JSONArray()
        private var guiStatus = "not_started"

        @JavascriptInterface
        @Synchronized
        fun emit(payload: String) {
            // The page constructs a safe report, never raw command responses.
            current = JSONObject(payload)
            persist()
            Log.i("AndroidIpcSmoke", "phase=${current.optString("phase")} status=${current.optString("status")}")
        }

        @Synchronized
        fun observation(phase: String, name: String, value: Boolean) {
            system.put(JSONObject().put("phase", phase).put(name, value))
            persist()
            Log.i("AndroidIpcSmoke", "phase=$phase $name=$value")
        }

        @Synchronized
        fun snapshot(): JSONObject = JSONObject(current.toString())

        @Synchronized
        fun guiEvent(phase: String, status: String, details: JSONObject = JSONObject()) {
            guiStatus = if (status == "fail") "FAIL" else if (phase == "gui_complete") "PASS" else "running"
            gui.put(JSONObject().put("phase", phase).put("status", status).put("details", details))
            persist()
            Log.i("AndroidIpcSmoke", "guiPhase=$phase guiStatus=$guiStatus")
        }

        private fun persist() {
            val output = JSONObject(current.toString()).put("androidSystemObservations", system)
                .put("guiStatus", guiStatus).put("guiEvents", gui)
            val temporary = File(destination.parentFile, destination.name + ".tmp")
            temporary.writeText(output.toString(2))
            check(temporary.renameTo(destination)) { "Could not persist smoke report" }
        }
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            findWebView(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun evaluate(script: String): String {
        val latch = CountDownLatch(1)
        val response = AtomicReference<String>()
        instrumentation.runOnMainSync {
            webView.get().evaluateJavascript(script) {
                response.set(it)
                latch.countDown()
            }
        }
        assertTrue("WebView evaluation did not return", latch.await(5, TimeUnit.SECONDS))
        return response.get()
    }

    private fun vpnTransportPresent(): Boolean {
        instrumentation.uiAutomation.adoptShellPermissionIdentity(Manifest.permission.ACCESS_NETWORK_STATE)
        return try {
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            @Suppress("DEPRECATION")
            connectivity.allNetworks.any {
                connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            }
        } finally {
            instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    private fun acceptVpnConsentIfPresent() {
        if (device.currentPackageName == "com.android.vpndialogs") {
            device.findObject(By.res("android", "button1"))?.click()
        }
    }

    private fun guiSnapshot(): JSONObject {
        val encoded = evaluate("""
        (() => {
          const button = document.querySelector('.page-heading .actions button');
          const stage = document.querySelector('[data-testid="vpn-failure-detail"] code')?.textContent || '';
          return {control: button?.textContent?.trim() || '', busy: !button || button.disabled,
            vpnStatus: document.querySelector('.client-topbar-actions .status')?.textContent?.trim() || '',
            fixtureListed: [...document.querySelectorAll('.client-network-item strong')].some(node => node.textContent === 'android-gui-smoke'),
            failureCode: /^vpn_[a-z0-9_]{1,80}$/.test(stage) ? stage : '',
            hasAlert: !!document.querySelector('[role="alert"]')};
        })()
        """.trimIndent())
        return if (encoded == "null") JSONObject().put("busy", true) else JSONObject(encoded)
    }

    private fun waitGui(connected: Boolean): JSONObject {
        val deadline = SystemClock.elapsedRealtime() + 30000
        var last = JSONObject()
        while (SystemClock.elapsedRealtime() < deadline) {
            acceptVpnConsentIfPresent()
            last = guiSnapshot()
            assertEquals("Actual UI VPN failure", "", last.optString("failureCode"))
            val label = if (connected) "Disconnect" else "Connect"
            val status = if (connected) "VPN connected" else "VPN disconnected"
            if (!last.optBoolean("busy") && last.optString("control") == label
                && last.optString("vpnStatus") == status && last.optBoolean("fixtureListed")
                && !last.optBoolean("hasAlert")) return last
            SystemClock.sleep(100)
        }
        throw AssertionError("Actual UI did not reach the expected VPN state; safe stage=${last.optString("failureCode")}")
    }

    private fun readGuiNativeObservation(): JSONObject {
        evaluate("""
            window.__ANDROID_GUI_OBSERVATION__ = {done: false};
            Promise.allSettled([window.__TAURI_INTERNALS__.invoke('plugin:vpnservice|get_vpn_status'),
              window.__TAURI_INTERNALS__.invoke('get_local_vpn_status'),
              window.__TAURI_INTERNALS__.invoke('is_local_vpn_connected')]).then(results => {
                const native = results[0].status === 'fulfilled' ? results[0].value : null;
                const owned = results[1].status === 'fulfilled' ? results[1].value : undefined;
                const connected = results[2].status === 'fulfilled' && results[2].value === true;
                window.__ANDROID_GUI_OBSERVATION__ = {done: true,
                  directQueryResolved: results[0].status === 'fulfilled',
                  validatedQueryResolved: results[1].status === 'fulfilled',
                  connectedQueryResolved: results[2].status === 'fulfilled', nativeState: native?.state || '',
                  nativeEstablished: native?.established === true && native?.running === true,
                  nativeStopped: native?.state === 'stopped' && native?.running === false,
                  correctInstance: native?.instanceId === 'dfb23100-1fa0-4000-8000-000000000003',
                  positiveFd: Number.isInteger(native?.fd) && native.fd > 0,
                  validatedOwner: !!native && !!owned && owned.requestId === native.requestId && owned.instanceId === native.instanceId && owned.fd === native.fd,
                  validatedCleared: owned === null, connected: connected === true};
              }, () => { window.__ANDROID_GUI_OBSERVATION__ = {done: true, queryRejected: true}; });
            'observing'
        """.trimIndent())
        val deadline = SystemClock.elapsedRealtime() + 10000
        while (SystemClock.elapsedRealtime() < deadline) {
            val status = JSONObject(evaluate("window.__ANDROID_GUI_OBSERVATION__"))
            if (status.optBoolean("done")) {
                return status
            }
            SystemClock.sleep(50)
        }
        throw AssertionError("Read-only UI native observation did not settle")
    }

    private fun realGuiFlow(observer: Observer) {
        var phase = "gui_fixture_prepare"
        try {
            observer.guiEvent(phase, "begin")
            evaluate("window.__ANDROID_IPC_SMOKE__.prepareGui(); 'preparing'")
            val prepareDeadline = SystemClock.elapsedRealtime() + 30000
            while (true) {
                val status = JSONTokener(evaluate("window.__ANDROID_GUI_PREPARE__")).nextValue().toString()
                if (status == "ready") break
                assertEquals("GUI fixture preparation rejected", "pending", status)
                assertTrue("GUI fixture preparation timed out", SystemClock.elapsedRealtime() < prepareDeadline)
                SystemClock.sleep(100)
            }
            observer.guiEvent(phase, "pass")
            phase = "gui_index_navigation"
            val index = JSONTokener(evaluate("new URL('index.html', location.href).href")).nextValue() as String
            instrumentation.runOnMainSync { webView.get().loadUrl(index) }
            waitGui(false)
            observer.guiEvent(phase, "pass")
            for (cycle in 1..2) {
                phase = "gui_connect_button_$cycle"
                observer.guiEvent(phase, "begin")
                // This is the actual top-level Connect button. Its React handler
                // executes NativeSession.startLocalClient -> mobile_vpn. Never
                // call resume/start/set_tun_fd ourselves during this UI flow.
                assertEquals("clicked", JSONTokener(evaluate("""
                    (() => { const button = document.querySelector('.page-heading .actions button');
                      if (!button || button.disabled || button.textContent.trim() !== 'Connect') return 'unavailable';
                      button.click(); return 'clicked'; })()
                """.trimIndent())).nextValue())
                waitGui(true)
                observer.guiEvent(phase, "pass")
                phase = "gui_native_and_validated_$cycle"
                val connected = readGuiNativeObservation()
                connected.put("vpnTransportPresent", vpnTransportPresent())
                observer.guiEvent(phase, "observed", connected)
                assertTrue("Read-only GUI queries rejected", connected.optBoolean("directQueryResolved")
                    && connected.optBoolean("validatedQueryResolved") && connected.optBoolean("connectedQueryResolved"))
                assertTrue("Actual UI did not establish its native TUN", connected.optBoolean("nativeEstablished")
                    && connected.optBoolean("correctInstance") && connected.optBoolean("positiveFd"))
                assertTrue("Actual UI did not bind its TUN to Core", connected.optBoolean("validatedOwner") && connected.optBoolean("connected"))
                assertTrue("Actual UI connected label without system VPN", connected.optBoolean("vpnTransportPresent"))
                observer.guiEvent(phase, "pass", connected)
                phase = "gui_connected_stable_$cycle"
                SystemClock.sleep(4500) // Cross two actual NativeSession poll intervals.
                waitGui(true)
                assertTrue("Actual UI lost the system VPN after its poll", vpnTransportPresent())
                observer.guiEvent(phase, "pass")
                phase = "gui_disconnect_button_$cycle"
                observer.guiEvent(phase, "begin")
                assertEquals("clicked", JSONTokener(evaluate("""
                    (() => { const button = document.querySelector('.page-heading .actions button');
                      if (!button || button.disabled || button.textContent.trim() !== 'Disconnect') return 'unavailable';
                      button.click(); return 'clicked'; })()
                """.trimIndent())).nextValue())
                waitGui(false)
                observer.guiEvent(phase, "pass")
                phase = "gui_stopped_native_and_validated_$cycle"
                val stopped = readGuiNativeObservation()
                stopped.put("vpnTransportPresent", vpnTransportPresent())
                observer.guiEvent(phase, "observed", stopped)
                assertTrue("Read-only GUI queries rejected", stopped.optBoolean("directQueryResolved")
                    && stopped.optBoolean("validatedQueryResolved") && stopped.optBoolean("connectedQueryResolved"))
                assertTrue("Actual UI did not close native VPN and Core ownership", stopped.optBoolean("nativeStopped")
                    && stopped.optBoolean("validatedCleared") && !stopped.optBoolean("connected"))
                assertTrue("Actual UI Disconnect left a system VPN", !stopped.optBoolean("vpnTransportPresent"))
                observer.guiEvent(phase, "pass", stopped)
            }
            observer.guiEvent("gui_complete", "pass")
        } catch (error: Throwable) {
            val details = try { guiSnapshot() } catch (_: Throwable) { JSONObject() }
            observer.guiEvent(phase, "fail", details)
            throw error
        }
    }

    @Test(timeout = 360000)
    fun realWebViewCanStartObserveStopAndReconnectAndroidVpn() {
        assertEquals("com.kkrainbow.easytier.adapted.debug", context.packageName)
        val observer = Observer(File(context.filesDir, "android-ipc-smoke-report.json"))
        assertTrue("Fresh emulator already has a VPN transport", !vpnTransportPresent())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val viewDeadline = SystemClock.elapsedRealtime() + 30000
            while (webView.get() == null && SystemClock.elapsedRealtime() < viewDeadline) {
                scenario.onActivity { activity ->
                    findWebView(activity.window.decorView)?.let { webView.set(it) }
                }
                if (webView.get() == null) SystemClock.sleep(100)
            }
            assertNotNull("MainActivity did not create a real WebView", webView.get())
            val readyDeadline = SystemClock.elapsedRealtime() + 30000
            while (evaluate("Boolean(window.__ANDROID_IPC_SMOKE__ && window.__TAURI_INTERNALS__?.invoke)") != "true") {
                assertTrue("Embedded smoke document or Tauri IPC was not ready", SystemClock.elapsedRealtime() < readyDeadline)
                SystemClock.sleep(100)
            }
            // Android exposes newly added JavaScript interfaces on the next
            // document load. Wait for the first test document before reloading
            // so an old ready event cannot acknowledge the replacement page.
            instrumentation.runOnMainSync {
                webView.get().addJavascriptInterface(observer, "AndroidIpcSmokeObserver")
                webView.get().reload()
            }
            val observerDeadline = SystemClock.elapsedRealtime() + 30000
            while (observer.snapshot().optString("status") != "ready"
                || evaluate("Boolean(window.__ANDROID_IPC_SMOKE__ && window.__TAURI_INTERNALS__?.invoke && typeof window.AndroidIpcSmokeObserver?.emit === 'function')") != "true") {
                assertTrue("Reloaded WebView did not expose the test observer", SystemClock.elapsedRealtime() < observerDeadline)
                SystemClock.sleep(100)
            }
            evaluate("window.__ANDROID_IPC_SMOKE__.run(); 'started'")
            val deadline = SystemClock.elapsedRealtime() + 120000
            val acknowledged = mutableSetOf<String>()
            val consentSeen = mutableSetOf<String>()
            while (SystemClock.elapsedRealtime() < deadline) {
                val report = observer.snapshot()
                val status = report.optString("status")
                if (status == "PASS" || status == "FAIL") break
                val phase = report.optString("phase")
                if (phase.startsWith("vpn_permission_") && device.currentPackageName == "com.android.vpndialogs") {
                    // Already granted permission returns immediately: never wait
                    // for a dialog which Android has no reason to display.
                    device.findObject(By.res("android", "button1"))?.let {
                        it.click()
                        if (consentSeen.add(phase)) observer.observation(phase, "systemConsentDialogAccepted", true)
                    }
                }
                if ((phase.startsWith("system_vpn_present_") || phase.startsWith("system_vpn_absent_"))
                    && phase !in acknowledged) {
                    val present = vpnTransportPresent()
                    val wanted = phase.startsWith("system_vpn_present_")
                    if (present == wanted) {
                        observer.observation(phase, "vpnTransportPresent", present)
                        acknowledged.add(phase)
                        evaluate("window.__ANDROID_IPC_SMOKE__.acknowledgeSystem(); 'acknowledged'")
                    }
                }
                SystemClock.sleep(50)
            }
            val result = observer.snapshot()
            assertEquals("Last phase: ${result.optString("phase")}; safe reason: ${result.optString("failureReason")}",
                "PASS", result.optString("status"))
            assertEquals(2, result.optInt("cycles"))
            assertEquals(4, acknowledged.size)
            realGuiFlow(observer)
        }
    }
}
