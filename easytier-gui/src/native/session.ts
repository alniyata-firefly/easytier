import { type as osType } from '@tauri-apps/plugin-os'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'
import { normalizeVpnFailureCode, type Mode, type ServiceMode, type ServiceOptions, type SessionSnapshot, type VpnFailureCode } from './types'
import * as backend from './backend'
import { listenGlobalEvents } from './events'
import { loadEnabledNetworks, loadMode, loadStoredConfigs, saveMode, loadLastNetworkInstanceId, saveLastNetworkInstanceId, saveLocalClientPaused } from './storage'
import { applyServiceConfiguration, ServiceConfigurationError } from './service_configuration'
import { cancelPendingMobileVpnStart, consumePendingMobileVpnTileAction, disposeMobileVpnService, getMobileVpnError, getMobileVpnFailureCode, initMobileVpnService, initMobileManagementService, observeMobileVpnService, setMobileVpnTileActionHandler, syncMobileVpnService, suspendMobileVpnService, resumeMobileVpnService, isMobileVpnConnected, waitForMobileVpnInstance } from './mobile_vpn'
import { executeVpnTileAction } from './mobile_vpn_tile'
import { GUIRemoteClient } from './client'
import { supportsUplinkSelectionForOs } from '../../../easytier-web/frontend-lib/src/modules/uplinkCapabilities'

function serviceOptions(mode: ServiceMode): ServiceOptions {
  return { config_dir: mode.config_dir, rpc_portal: mode.rpc_portal, file_log_level: mode.file_log_level, file_log_dir: mode.file_log_dir, config_server: mode.config_server_url }
}
function cloneMode(mode: Mode): Mode { return JSON.parse(JSON.stringify(mode)) as Mode }
function comparable(mode: Mode): string {
  const copy = cloneMode(mode)
  if (copy.mode === 'service') delete copy.installed_core_version
  return JSON.stringify(copy)
}
const VPN_CONNECTION_TIMEOUT_MS = 150000
export class NativeSession {
  private snapshot: SessionSnapshot
  private subscribers = new Set<() => void>()
  private cleanups: Array<() => void> = []
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private initializing?: Promise<void>
  private operation: Promise<unknown> = Promise.resolve()
  private manuallyStopped = false
  private localStopIncomplete = false
  private vpnConnectionDeadline?: number
  private persistLocal = false
  private generation = 0
  private vpnIntentRevision = 0
  private reconnectAttempts = 0
  private retryAt = 0
  private configurationClient?: { mode: Mode; connected: boolean; client: GUIRemoteClient }
  get remoteClient(): GUIRemoteClient {
    const { mode, connected } = this.snapshot
    if (this.configurationClient?.mode === mode && this.configurationClient.connected === connected) return this.configurationClient.client
    const client = new GUIRemoteClient({
      offline: () => mode.mode === 'normal' && !connected,
      current: () => !this.disposed && this.snapshot.mode === mode && this.snapshot.connected === connected,
      changed: () => this.patch({}),
      runtimeAllowed: () => this.snapshot.platform !== 'android' || !this.snapshot.clientPaused,
      remotePersistence: () => mode.mode !== 'normal',
    })
    this.configurationClient = { mode, connected, client }
    return client
  }

  constructor() {
    const platform = osType()
    this.snapshot = { platform, version: '', mode: loadMode(platform), connected: false, managementConnected: false, managementState: 'disconnected', clientPaused: platform === 'android', vpnConnected: false, serviceStatus: 'NotInstalled', busy: false, revision: 0 }
  }
  getSnapshot = (): SessionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.subscribers.add(listener); return () => this.subscribers.delete(listener) }
  private patch(update: Partial<SessionSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...update, revision: this.snapshot.revision + 1 }
    this.subscribers.forEach(listener => listener())
  }
  private captureVpnFailure(error?: unknown, fallback: VpnFailureCode = 'vpn_start_failed') {
    if (this.snapshot.platform !== 'android') return
    const code = normalizeVpnFailureCode(getMobileVpnFailureCode()) ?? normalizeVpnFailureCode(getMobileVpnError())
      ?? normalizeVpnFailureCode(error instanceof Error ? error.message : error) ?? fallback
    this.patch({ vpnFailureCode: code })
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.catch(() => undefined).then(async () => {
      if (this.disposed) throw new Error('session_disposed')
      this.generation++
      this.patch({ busy: true, errorCode: undefined })
      try { return await task() }
      finally { this.patch({ busy: false }) }
    })
    this.operation = next
    return next
  }
  initialize(): Promise<void> {
    if (this.initializing) return this.initializing
    this.initializing = this.serial(async () => {
      try {
        if (this.snapshot.platform === 'android') {
          try { this.retainCleanup(await initMobileVpnService()) }
          catch (error) { this.captureVpnFailure(error, 'vpn_listener_failed'); throw error }
        }
        if (this.disposed) return
        this.retainCleanup(await listenGlobalEvents({
          android: this.snapshot.platform === 'android', persist: () => this.persistLocal,
          changed: () => this.patch({}), error: code => this.patch({ errorCode: code }),
        }))
        this.patch({ version: await backend.getEasytierVersion() })
        if (this.disposed) return
        if (this.snapshot.platform === 'android') {
          // Management connects with the App. Native intent only controls the
          // Android VPN interface; persisted JS state cannot enable that VPN.
          let enabled = await backend.isLocalClientEnabled()
          if (this.disposed) return
          this.patch({ clientPaused: !enabled })
          if (enabled) await resumeMobileVpnService()
          if (enabled) this.patch({ vpnConnected: await observeMobileVpnService() })
          // A revoked service can have stopped before Core acquired its lease
          // while the old WebView was absent. Do not resume that old intent.
          const revoked = enabled && getMobileVpnError() === 'vpn_permission_revoked'
          if (revoked) {
            enabled = false
            this.captureVpnFailure('vpn_permission_revoked')
            try { await this.pauseLocalClient(); this.patch({ errorCode: 'vpn_permission_revoked' }) }
            catch { /* Preserve the cleanup error and Retry Disconnect state. */ }
          }
          await initMobileManagementService().catch(() => this.patch({ errorCode: 'management_foreground_failed' }))
          if (await backend.isClientRunning().catch(() => false)) await this.observeLocalClient()
          else await this.connect(cloneMode(this.snapshot.mode))
          if (revoked && !this.localStopIncomplete) this.patch({ errorCode: 'vpn_permission_revoked' })
          if (enabled && !this.snapshot.vpnConnected) {
            this.vpnConnectionDeadline = Date.now() + VPN_CONNECTION_TIMEOUT_MS
            this.patch({ vpnTransition: 'connecting' })
            try {
              await syncMobileVpnService({ strict: true })
              if (!await isMobileVpnConnected() && this.snapshot.mode.config_server_url) waitForMobileVpnInstance()
            }
            catch (error) {
              this.captureVpnFailure(error)
              try { await this.pauseLocalClient(); this.patch({ errorCode: 'client_start_failed' }) }
              catch { /* The incomplete cleanup state is retained for Retry Disconnect. */ }
            }
          }
        } else await this.connect(cloneMode(this.snapshot.mode))
        if (this.snapshot.platform === 'android') {
          setMobileVpnTileActionHandler(async action => {
            if (action === 'stop') { await this.stopLocalClient(); return }
            await this.startLocalClient()
          })
          this.cleanups.push(() => setMobileVpnTileActionHandler())
        }
      } catch { this.patch({ connected: false, errorCode: this.snapshot.errorCode || 'client_initialization_failed' }) }
      this.schedulePoll()
    }).then(async () => {
      // Tile actions call the same serialized lifecycle as the visible UI.
      // Consume after initialize releases that queue, not from inside it.
      if (!this.disposed && this.snapshot.platform === 'android') {
        await consumePendingMobileVpnTileAction().catch(() => this.patch({ errorCode: this.snapshot.errorCode || 'client_operation_failed' }))
      }
    })
    return this.initializing
  }
  private retainCleanup(cleanup: () => void) {
    if (this.disposed) cleanup()
    else this.cleanups.push(cleanup)
  }
  private async observeLocalClient() {
    const connected = await backend.isClientRunning().catch(() => false)
    const managementState = connected && this.snapshot.mode.config_server_url
      ? await backend.getWebClientStatus().catch(() => 'unknown' as const) : 'disconnected'
    if (this.disposed) return
    this.persistLocal = true
    this.manuallyStopped = false
    this.patch({ connected, managementState, managementConnected: managementState === 'authorized' })
  }
  private async initializeConnection(mode: Mode, url?: string, attempts = 1) {
    for (let index = 0; index < attempts; index++) {
      if (this.disposed) throw new Error('session_disposed')
      try { await backend.initRpcConnection(mode.mode === 'normal', url); break }
      catch {
        if (index + 1 === attempts) throw new Error('rpc_connection_failed')
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    if (this.disposed) throw new Error('session_disposed')
    // Only local user configurations restore an enabled state. Centrally managed
    // networks are reconciled by their server, and remote/service processes keep
    // their own lifecycle instead of importing enabled local GUI configurations.
    const localIds = new Set(loadStoredConfigs().filter(entry => entry.source !== 'web').map(entry => entry.config.instance_id))
    const current = await backend.listNetworkInstanceIds().catch(() => undefined)
    const liveIds = (current?.running_inst_ids || []).map(Utils.UuidToStr)
    const enabled = mode.mode === 'normal' && !(this.snapshot.platform === 'android' && this.snapshot.clientPaused)
      ? [...new Set([...liveIds, ...loadEnabledNetworks().filter(id => localIds.has(id))])] : []
    await backend.sendConfigs(enabled, mode.mode === 'remote' || supportsUplinkSelectionForOs(this.snapshot.platform), mode.mode === 'normal')
    if (!await backend.isClientRunning()) throw new Error('rpc_connection_failed')
  }
  private async connect(mode: Mode) {
    const old = this.snapshot.mode
    if (this.snapshot.platform === 'android' && mode.mode !== 'normal') throw new Error('mode_not_supported')
    if (mode.mode === 'remote' && !mode.remote_rpc_address?.trim()) throw new Error('remote_address_required')
    if (mode.mode === 'service' && (!mode.config_dir || !mode.file_log_dir || !mode.rpc_portal || !mode.file_log_level)) throw new Error('service_config_required')
    if (mode.mode === 'normal' && mode.enable_rpc_port_listen) {
      const port = Number(mode.rpc_listen_port ?? 15999)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('rpc_port_invalid')
      mode.rpc_portal = `tcp://0.0.0.0:${port}`
    } else if (mode.mode === 'normal' && mode.enable_rpc_port_listen === false) mode.rpc_portal = undefined
    this.persistLocal = mode.mode === 'normal'
    if (old.mode === 'service' && mode.mode !== 'service') {
      if (await backend.getServiceStatus() === 'Running') {
        await backend.setServiceStatus(false)
        for (let attempt = 0; await backend.getServiceStatus() === 'Running'; attempt++) {
          if (attempt >= 50) throw new Error('service_stop_timeout')
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
      await backend.initService(undefined)
    }
    if (this.disposed) throw new Error('session_disposed')
    if (mode.mode === 'service') {
      const url = `tcp://${mode.rpc_portal.replace('0.0.0.0', '127.0.0.1')}`
      const version = this.snapshot.version || await backend.getEasytierVersion()
      const status = await backend.getServiceStatus()
      if (status === 'NotInstalled' || comparable(mode) !== comparable(old) || mode.installed_core_version !== version) {
        await applyServiceConfiguration(serviceOptions(mode), old.mode === 'service' ? serviceOptions(old) : undefined, {
          getStatus: backend.getServiceStatus, setEnabled: backend.setServiceStatus, install: backend.initService,
          ensureReady: () => this.initializeConnection(mode, url, 5),
        })
        mode.installed_core_version = version
      } else {
        if (status === 'Stopped') await backend.setServiceStatus(true)
        await this.initializeConnection(mode, url, 5)
      }
    } else {
      await this.initializeConnection(mode, mode.mode === 'remote' ? mode.remote_rpc_address : mode.rpc_portal)
      if (mode.mode === 'normal') await backend.initWebClient(mode.config_server_url || undefined)
    }
    if (this.disposed) throw new Error('session_disposed')
    saveMode(mode)
    this.manuallyStopped = false
    this.reconnectAttempts = 0
    this.retryAt = 0
    this.patch({ mode, connected: true, managementConnected: false,
      managementState: mode.config_server_url ? mode.mode === 'normal' ? 'connecting' : 'unknown' : 'disconnected',
      errorCode: mode.config_server_needs_credentials ? 'config_server_credentials_required' : undefined,
      serviceStatus: this.snapshot.platform === 'android' ? 'NotInstalled' : await backend.getServiceStatus().catch(() => 'NotInstalled' as const) })
  }
  applyMode(mode: Mode): Promise<void> {
    const requested = cloneMode(mode)
    return this.serial(async () => {
      const previous = cloneMode(this.snapshot.mode)
      const previousServiceStatus = previous.mode === 'service' ? await backend.getServiceStatus() : undefined
      try { await this.connect(requested) }
      catch (error) {
        this.persistLocal = previous.mode === 'normal'
        const serviceFailure = error instanceof ServiceConfigurationError
        if (serviceFailure && (error.restoredStatus === 'Stopped' || error.restoredStatus === 'NotInstalled')) {
          this.manuallyStopped = true
          this.patch({ connected: false, serviceStatus: error.restoredStatus, errorCode: error.message })
        } else if (previous.mode === 'service' && requested.mode !== 'service'
          && (previousServiceStatus === 'Stopped' || previousServiceStatus === 'NotInstalled')) {
          // A failed move to another mode must restore installation settings
          // without turning an explicitly stopped background service back on.
          try {
            await backend.initWebClient(undefined)
            await backend.initService(previousServiceStatus === 'Stopped' ? serviceOptions(previous) : undefined)
          } catch { this.patch({ errorCode: 'service_update_and_restore_failed' }) }
          this.manuallyStopped = true
          this.patch({ connected: false, managementConnected: false, managementState: 'disconnected', serviceStatus: previousServiceStatus,
            errorCode: this.snapshot.errorCode || 'mode_apply_failed' })
        } else {
          try { await this.connect(previous) } catch { this.patch({ connected: false }) }
          this.patch({ errorCode: serviceFailure ? error.message : 'mode_apply_failed' })
        }
        throw new Error(this.snapshot.errorCode || 'mode_apply_failed')
      }
    })
  }
  reconnect(): Promise<void> { return this.applyMode(this.snapshot.mode) }
  private assertLocalAndroid() {
    if (this.snapshot.platform !== 'android' || this.snapshot.mode.mode !== 'normal') throw new Error('mode_not_supported')
  }
  private async pauseLocalClient() {
    this.assertLocalAndroid()
    this.vpnConnectionDeadline = undefined
    saveLocalClientPaused(true)
    this.patch({ clientPaused: true, vpnConnected: false, vpnTransition: 'disconnecting' })
    // The VPN interface and its Core descriptor must both be released, while
    // management authentication and saved network configuration stay live.
    const vpn = suspendMobileVpnService()
    const core = backend.stopLocalClient()
    const results = await Promise.allSettled([vpn, core])
    if (results.some(result => result.status === 'rejected')) {
      this.localStopIncomplete = true
      this.patch({ errorCode: 'client_stop_failed', vpnStopIncomplete: true, vpnTransition: undefined })
      throw new Error('client_stop_failed')
    }
    this.localStopIncomplete = false
    this.patch({ errorCode: undefined, vpnStopIncomplete: false, vpnTransition: undefined })
  }
  stopLocalClient(): Promise<void> {
    if (this.snapshot.platform === 'android' && this.snapshot.mode.mode === 'normal') {
      this.vpnIntentRevision++
      cancelPendingMobileVpnStart()
    }
    return this.serial(async () => {
      this.patch({ vpnFailureCode: undefined })
      try { await this.pauseLocalClient() }
      catch (error) { this.captureVpnFailure(error, 'vpn_stop_failed'); throw error }
    })
  }
  startLocalClient(): Promise<void> {
    const intent = ++this.vpnIntentRevision
    const assertIntent = () => {
      if (this.disposed || intent !== this.vpnIntentRevision) throw new Error('vpn_request_canceled')
    }
    return this.serial(async () => {
      this.assertLocalAndroid()
      assertIntent()
      this.patch({ vpnFailureCode: undefined })
      try {
        if (this.localStopIncomplete) await this.pauseLocalClient()
        assertIntent()
        this.vpnConnectionDeadline = Date.now() + VPN_CONNECTION_TIMEOUT_MS
        this.patch({ vpnTransition: 'connecting' })
        await backend.resumeLocalClient()
        assertIntent()
        await resumeMobileVpnService()
        assertIntent()
        this.patch({ clientPaused: false })
        if (!this.snapshot.connected) await this.connect(cloneMode(this.snapshot.mode))
        assertIntent()
        const result = await executeVpnTileAction('start', this.remoteClient, {
          lastInstanceId: loadLastNetworkInstanceId(),
          syncVpnService: async preferredInstanceId => {
            assertIntent()
            await syncMobileVpnService({ strict: true, preferredInstanceId })
            assertIntent()
          },
        })
        assertIntent()
        // Managed instances are recreated only from the controller's current
        // desired state. A first connection can wait for its next heartbeat.
        if (!result.instanceId && !this.snapshot.mode.config_server_url) throw new Error('vpn_no_network')
        if (result.pending || !result.instanceId) waitForMobileVpnInstance(result.instanceId)
        if (result.instanceId) saveLastNetworkInstanceId(result.instanceId)
        saveLocalClientPaused(false)
        const vpnConnected = await isMobileVpnConnected().catch(() => false)
        assertIntent()
        if (vpnConnected) this.vpnConnectionDeadline = undefined
        this.patch({ clientPaused: false, vpnConnected, vpnTransition: vpnConnected ? undefined : 'connecting', vpnFailureCode: undefined })
      } catch (error) {
        if (intent !== this.vpnIntentRevision || this.disposed)
          throw new Error('vpn_request_canceled')
        this.captureVpnFailure(error, this.localStopIncomplete ? 'vpn_stop_failed' : 'vpn_start_failed')
        try { await this.pauseLocalClient() }
        catch { throw new Error('client_stop_failed') }
        const code = error instanceof Error && error.message === 'vpn_no_network' ? 'vpn_no_network' : 'client_start_failed'
        this.patch({ errorCode: code })
        throw new Error(code)
      }
    })
  }
  stopService(): Promise<void> {
    return this.serial(async () => {
      this.manuallyStopped = true
      try { await backend.setServiceStatus(false); this.patch({ connected: false, managementConnected: false, managementState: 'disconnected', serviceStatus: 'Stopped' }) }
      catch { this.patch({ errorCode: 'service_stop_failed' }); throw new Error('service_stop_failed') }
    })
  }
  uninstallService(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.connect({ mode: 'normal', config_server_url: this.snapshot.mode.config_server_url })
        await backend.initService(undefined)
        this.patch({ serviceStatus: 'NotInstalled' })
      } catch { this.patch({ errorCode: 'service_uninstall_failed' }); throw new Error('service_uninstall_failed') }
    })
  }
  private schedulePoll() {
    if (this.disposed) return
    this.timer = setTimeout(async () => {
      if (this.disposed) return
      if (!this.snapshot.busy) {
        const generation = this.generation
        const connected = await backend.isClientRunning().catch(() => false)
        const managementState = !connected || !this.snapshot.mode.config_server_url ? 'disconnected'
          : this.snapshot.mode.mode === 'normal' ? await backend.getWebClientStatus().catch(() => 'unknown' as const) : 'unknown'
        const managementConnected = managementState === 'authorized'
        const android = this.snapshot.platform === 'android'
        const nativeEnabled = android ? await backend.isLocalClientEnabled().catch(() => undefined) : undefined
        const vpnConnected = android && nativeEnabled !== false && !this.snapshot.clientPaused && await observeMobileVpnService().catch(() => false)
        if (this.disposed) return
        if (generation !== this.generation || this.snapshot.busy) { this.schedulePoll(); return }
        const shouldReconnect = !connected && !this.manuallyStopped && Date.now() >= this.retryAt
        if (connected !== this.snapshot.connected || managementState !== this.snapshot.managementState || vpnConnected !== this.snapshot.vpnConnected) this.patch({ connected, managementConnected, managementState, vpnConnected })
        if (android && !this.snapshot.clientPaused) {
          const vpnError = getMobileVpnError()
          if (vpnConnected && !vpnError) {
            this.vpnConnectionDeadline = undefined
            if (this.snapshot.vpnTransition || this.snapshot.vpnFailureCode) this.patch({ vpnTransition: undefined, vpnFailureCode: undefined })
          } else {
            this.vpnConnectionDeadline ??= Date.now() + VPN_CONNECTION_TIMEOUT_MS
            const timedOut = Date.now() >= this.vpnConnectionDeadline
            if (nativeEnabled === false || vpnError || timedOut) {
              if (vpnError || timedOut) this.captureVpnFailure(vpnError, timedOut ? 'vpn_connection_timeout' : 'vpn_start_failed')
              const errorCode = vpnError === 'vpn_permission_revoked' ? vpnError
                : timedOut || vpnError === 'vpn_connection_timeout' ? 'vpn_connection_timeout'
                : vpnError ? 'client_start_failed' : undefined
              // Native revocation and background reconciliation failures use the
              // same bounded cleanup as Disconnect; management remains live.
              await this.serial(() => this.pauseLocalClient()).catch(() => undefined)
              if (!this.localStopIncomplete && errorCode) this.patch({ errorCode })
            }
          }
        }
        if (shouldReconnect) {
          await this.reconnect().catch(() => undefined)
          if (!this.snapshot.connected) {
            this.reconnectAttempts++
            this.retryAt = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(this.reconnectAttempts, 4))
          }
        }
      }
      this.schedulePoll()
    }, 2000)
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.cleanups.splice(0).forEach(cleanup => cleanup())
    if (this.snapshot.platform === 'android') disposeMobileVpnService()
    this.subscribers.clear()
  }
}
