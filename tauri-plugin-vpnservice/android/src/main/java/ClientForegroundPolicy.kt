package com.plugin.vpnservice

class ClientForegroundPolicy(
    private val readEnabled: () -> Boolean,
    private val writeEnabled: (Boolean) -> Unit,
    private val updateService: (Boolean) -> Unit,
) {
    fun setEnabled(enabled: Boolean) {
        writeEnabled(enabled)
        updateService(enabled)
    }

    fun onVpnChanged(running: Boolean) {
        updateService(readEnabled() && !running)
    }
}
