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

        private fun persist() {
            val output = JSONObject(current.toString()).put("androidSystemObservations", system)
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

    @Test(timeout = 180000)
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
        }
    }
}
