package com.plugin.vpnservice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientForegroundPolicyTest {
    @Test
    fun warmManagementResumeReusesVpnForegroundAndVpnStopRestoresKeepalive() {
        var enabled = false
        var vpnRunning = true
        val service = mutableListOf<Boolean>()
        val policy = ClientForegroundPolicy({ enabled }, { enabled = it }, { service.add(it) }, { vpnRunning })
        policy.setEnabled(true)
        policy.setEnabled(true)
        assertTrue(enabled)
        assertEquals(listOf(false, false), service)
        vpnRunning = false
        policy.onVpnChanged(false)
        assertTrue(enabled)
        assertEquals(listOf(false, false, true), service)
    }

    @Test
    fun pausedClientStaysStoppedAfterLateRevokeOrDestroy() {
        var enabled = true
        val service = mutableListOf<Boolean>()
        val policy = ClientForegroundPolicy({ enabled }, { enabled = it }, { service.add(it) })
        policy.setEnabled(false)
        policy.onVpnChanged(false)
        policy.onVpnChanged(false)
        assertFalse(enabled)
        assertEquals(listOf(false, false, false), service)
    }

    @Test
    fun internalVpnRebuildPreservesTheRunningClientKeepalive() {
        var enabled = true
        val service = mutableListOf<Boolean>()
        val policy = ClientForegroundPolicy({ enabled }, { enabled = it }, { service.add(it) })
        policy.onVpnChanged(true)
        policy.onVpnChanged(false)
        policy.onVpnChanged(true)
        assertTrue(enabled)
        assertEquals(listOf(false, true, false), service)
    }

    @Test
    fun explicitResumeRestoresKeepaliveAndRecreatedPolicyReadsSavedPause() {
        var enabled = true
        val service = mutableListOf<Boolean>()
        val policy = ClientForegroundPolicy({ enabled }, { enabled = it }, { service.add(it) })
        policy.setEnabled(false)
        val recreated = ClientForegroundPolicy({ enabled }, { enabled = it }, { service.add(it) })
        recreated.onVpnChanged(false)
        recreated.setEnabled(true)
        recreated.onVpnChanged(true)
        assertTrue(enabled)
        assertEquals(listOf(false, false, true, false), service)
    }

    @Test
    fun serviceFailureIsReportedAndNeverClearsThePause() {
        var enabled = true
        val policy = ClientForegroundPolicy({ enabled }, { enabled = it }, { error("fixture service stop failure") })
        var failed = false
        try {
            policy.setEnabled(false)
        } catch (_: IllegalStateException) {
            failed = true
        }
        assertTrue(failed)
        assertFalse(enabled)
    }
}
