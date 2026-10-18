// Embedded only by smoke.py's disposable debug build. This page calls the real
// Tauri IPC bridge; no application or plugin command is replaced by a mock.
(() => {
  const report = { schema: 1, status: 'ready', phase: 'ready', events: [], cycles: 0 }
  let acknowledgement
  let started = false
  const publish = () => window.AndroidIpcSmokeObserver?.emit(JSON.stringify(report))
  const event = (phase, status, details = {}) => {
    report.phase = phase
    report.events.push({ phase, status, atMs: Math.round(performance.now()), ...details })
    publish()
  }
  const smokeReason = Symbol('internal smoke failure')
  const fail = reason => { throw { [smokeReason]: reason } }
  const check = (condition, reason) => { if (!condition) fail(reason) }
  const nativeSummary = (status, owner) => {
    const knownStates = ['stopped', 'starting', 'established', 'stopping']
    const knownErrors = ['vpn_foreground_start_failed', 'vpn_tun_start_failed', 'vpn_service_busy',
      'vpn_stop_failed', 'client_foreground_start_failed', 'client_foreground_stop_failed']
    return {
      state: knownStates.includes(status.state) ? status.state : 'unknown',
      running: status.running === true,
      established: status.established === true,
      fdPositive: Number.isInteger(status.fd) && status.fd > 0,
      ...(owner ? { ownerMatches: status.instanceId === owner.instanceId && status.requestId === owner.requestId } : {}),
      error: status.errorMsg == null ? 'none' : knownErrors.includes(status.errorMsg) ? status.errorMsg : 'unknown',
      stopReason: status.stopReason == null ? 'none' : status.stopReason === 'system_revoked' ? 'system_revoked' : 'unknown',
    }
  }
  const safeRejection = error => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : error?.message
    const known = new Map([
      ['VPN status query timed out', 'core_native_status_timeout'],
      ['VPN status query task failed', 'core_native_status_task_failed'],
      ['VPN status is unavailable', 'core_native_status_unavailable'],
      ['Core TUN installation timed out', 'core_tun_install_timeout'],
      ['Core TUN installation failed', 'core_tun_install_failed'],
      ['TUN request is no longer current', 'tun_owner_not_current'],
      ['local client is paused', 'core_runtime_paused'],
    ])
    return error?.[smokeReason] || known.get(message) || 'invoke_rejected'
  }
  async function bounded(phase, operation, timeoutMs = 15000, success = 'pass', details = () => ({})) {
    event(phase, 'begin')
    const before = performance.now()
    let timer
    try {
      const result = await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject({ [smokeReason]: 'invoke_did_not_settle' }), timeoutMs)
        }),
      ])
      event(phase, success, { durationMs: Math.round(performance.now() - before), ...details(result) })
      return result
    } catch (error) {
      event(phase, 'fail', { reason: safeRejection(error), durationMs: Math.round(performance.now() - before) })
      throw error
    } finally { clearTimeout(timer) }
  }
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args)
  async function nativeStatus(phase, owner) {
    return bounded(phase, async () => {
      const status = await invoke('plugin:vpnservice|get_vpn_status')
      check(status && typeof status.running === 'boolean' && typeof status.state === 'string', 'invalid_native_status_shape')
      return status
    }, 15000, 'query_response', status => {
      const native = nativeSummary(status, owner)
      report.lastNativeState = { phase, ...native }
      return { native }
    })
  }
  async function waitStatus(phase, predicate, owner) {
    const deadline = performance.now() + 15000
    while (true) {
      const status = await nativeStatus(phase, owner)
      if (predicate(status)) {
        event(phase, 'transition_pass', { native: nativeSummary(status, owner) })
        return status
      }
      check(performance.now() < deadline, 'native_state_transition_timeout')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  async function waitForSystemObservation(phase) {
    const observed = new Promise(resolve => { acknowledgement = resolve })
    await bounded(phase, () => observed, 15000)
  }
  async function run() {
    if (started) return
    started = true
    report.status = 'running'
    publish()
    try {
      check(typeof window.__TAURI_INTERNALS__?.invoke === 'function', 'tauri_ipc_not_injected')
      const cold = await nativeStatus('cold_direct_js_status')
      check(cold.state === 'stopped' && !cold.running, 'cold_native_service_not_stopped')
      const version = await bounded('core_version', () => invoke('easytier_version'))
      check(typeof version === 'string' && version.startsWith('2.7.2'), 'wrong_core_version')
      report.coreVersion = version
      await bounded('local_rpc_init', () => invoke('init_rpc_connection', { isNormalMode: true }))
      const coldValidated = await bounded('cold_validated_getter', () => invoke('get_local_vpn_status'))
      check(coldValidated === null, 'cold_tun_already_attached')
      for (let cycle = 1; cycle <= 2; cycle++) {
        const instanceId = `dfb23100-1fa0-4000-8000-00000000000${cycle}`
        const requestId = `android-ipc-smoke-request-${cycle}`
        const owner = { instanceId, requestId }
        await bounded(`resume_${cycle}`, () => invoke('resume_local_client'))
        // A synthetic, isolated local network. No peers, management server,
        // default route or external STUN endpoint is needed to validate a TUN.
        const tomlConfig = `instance_id = "${instanceId}"
ipv4 = "10.254.254.${cycle}/24"
dhcp = false
listeners = []
stun_servers = []
tcp_stun_servers = []
stun_servers_v6 = []
[network_identity]
network_name = "android-ipc-smoke"
network_secret = "synthetic-smoke-only"
[flags]
no_tun = false
disable_p2p = true
disable_udp_hole_punching = true
disable_tcp_hole_punching = true
enable_ipv6 = false
`
        const cfg = await bounded(`config_parse_${cycle}`, () => invoke('generate_network_config', { tomlConfig }))
        await bounded(`core_start_${cycle}`, () => invoke('run_network_instance', { cfg, save: false }))
        const prepared = await bounded(`vpn_permission_${cycle}`, () => invoke('plugin:vpnservice|prepare_vpn'), 30000)
        check(prepared?.granted === true && !prepared.errorMsg, 'vpn_permission_not_granted')
        const receipt = await bounded(`native_start_${cycle}`, () => invoke('plugin:vpnservice|start_vpn', {
          requestId, instanceId, ipv4Addr: `10.254.254.${cycle}/24`, routes: ['10.254.254.0/24'],
          disallowedApplications: [], mtu: 1300,
        }))
        check(!receipt?.errorMsg, 'native_start_receipt_failed')
        const native = await waitStatus(`native_establish_status_${cycle}`, status =>
          status.state === 'established' && status.established === true && status.running, owner)
        check(native.instanceId === instanceId && native.requestId === requestId
          && Number.isInteger(native.fd) && native.fd > 0, 'native_tun_owner_or_fd_invalid')
        event(`native_owner_${cycle}`, 'pass', { ownerMatches: true, fdPositive: true })
        await bounded(`rust_set_tun_fd_${cycle}`, () => invoke('set_tun_fd', {
          fd: native.fd, instanceId, requestId,
        }), 15000)
        const validated = await bounded(`validated_getter_${cycle}`, () => invoke('get_local_vpn_status'))
        check(validated?.requestId === requestId && validated.instanceId === instanceId
          && validated.established === true && validated.fd === native.fd, 'validated_tun_owner_invalid')
        for (let sample = 0; sample < 10; sample++) {
          const [direct, owned, connected] = await bounded(`concurrent_status_${cycle}_${sample}`, () => Promise.all([
            invoke('plugin:vpnservice|get_vpn_status'), invoke('get_local_vpn_status'), invoke('is_local_vpn_connected'),
          ]))
          check(direct.requestId === requestId && owned?.requestId === requestId && connected === true,
            'concurrent_status_owner_invalid')
        }
        // Instrumentation separately observes Android's VPN transport. A
        // successful Core/IPC flag alone cannot satisfy this checkpoint.
        await waitForSystemObservation(`system_vpn_present_${cycle}`)
        const stop = await bounded(`native_stop_${cycle}`, () => invoke('plugin:vpnservice|stop_vpn'))
        check(!stop?.errorMsg, 'native_stop_receipt_failed')
        // Android keeps its auto-create service binding until the final TUN fd
        // closes. Release Core's owned duplicate before awaiting onDestroy.
        await bounded(`rust_clear_tun_fd_${cycle}`, () => invoke('clear_tun_fd', { instanceId, requestId }))
        await waitStatus(`native_stopped_status_${cycle}`, status => status.state === 'stopped' && !status.running, owner)
        await bounded(`core_stop_${cycle}`, () => invoke('stop_local_client'))
        const stopped = await bounded(`stopped_validated_getter_${cycle}`, () => invoke('get_local_vpn_status'))
        check(stopped === null, 'validated_tun_survived_stop')
        await waitForSystemObservation(`system_vpn_absent_${cycle}`)
        report.cycles = cycle
      }
      report.status = 'PASS'
      event('complete', 'pass')
    } catch (error) {
      report.status = 'FAIL'
      report.failurePhase = report.phase
      report.failureReason = safeRejection(error)
      publish()
      // Best-effort isolated test cleanup does not overwrite the failing stage.
      await Promise.allSettled([invoke('plugin:vpnservice|stop_vpn'), invoke('stop_local_client')])
    }
  }
  window.__ANDROID_IPC_SMOKE__ = {
    run,
    prepareGui: async () => {
      window.__ANDROID_GUI_PREPARE__ = 'pending'
      try {
        const instanceId = 'dfb23100-1fa0-4000-8000-000000000003'
        const cfg = await bounded('gui_fixture_parse', () => invoke('generate_network_config', { tomlConfig: `
instance_id = "${instanceId}"
ipv4 = "10.254.253.3/24"
dhcp = false
listeners = []
stun_servers = []
tcp_stun_servers = []
stun_servers_v6 = []
[network_identity]
network_name = "android-gui-smoke"
network_secret = "synthetic-smoke-only"
[flags]
no_tun = false
disable_p2p = true
disable_udp_hole_punching = true
disable_tcp_hole_punching = true
enable_ipv6 = false
` }))
        check(cfg.instance_id === instanceId, 'gui_fixture_identity_invalid')
        // The same process already has a live RPC manager. Seed native storage
        // as well as browser storage: a warm Session need not reload configs.
        const configs = [{ config: cfg, source: 'user' }]
        await bounded('gui_fixture_native_load', () => invoke('load_configs', { configs, enabledNetworks: [] }))
        localStorage.setItem('networkList', JSON.stringify(configs))
        localStorage.setItem('enabled_networks', '[]')
        localStorage.setItem('last_network_instance_id', instanceId)
        localStorage.setItem('local_client_paused', 'true')
        localStorage.setItem('app_mode', JSON.stringify({ mode: 'normal' }))
        localStorage.setItem('easytier.locale', 'en')
        window.__ANDROID_GUI_PREPARE__ = 'ready'
      } catch (error) {
        window.__ANDROID_GUI_PREPARE__ = safeRejection(error)
      }
    },
    acknowledgeSystem: () => { const done = acknowledgement; acknowledgement = undefined; done?.() },
    report,
  }
  publish()
})()
