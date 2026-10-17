package com.plugin.vpnservice

class ClientForegroundPolicy(
    private val readEnabled: () -> Boolean,
    private val writeEnabled: (Boolean) -> Unit,
    private val updateService: (Boolean) -> Unit,
    private val readVpnRunning: () -> Boolean = { false },
) {
    fun setEnabled(enabled: Boolean) {
        writeEnabled(enabled)
        updateService(enabled && !readVpnRunning())
    }

    fun onVpnChanged(running: Boolean) {
        updateService(readEnabled() && !running)
    }
}
