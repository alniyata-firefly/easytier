import { type as osType } from '@tauri-apps/plugin-os'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'
import type { Mode, ServiceMode, ServiceOptions, SessionSnapshot } from './types'
import * as backend from './backend'
import { listenGlobalEvents } from './events'
import { loadEnabledNetworks, loadMode, loadStoredConfigs, saveMode, loadLastNetworkInstanceId, saveLastNetworkInstanceId, loadLocalClientPaused, saveLocalClientPaused } from './storage'
import { applyServiceConfiguration, ServiceConfigurationError } from './service_configuration'
import { consumePendingMobileVpnTileAction, disposeMobileVpnService, initMobileVpnService, setMobileVpnTileActionHandler, syncMobileVpnService, suspendMobileVpnService, resumeMobileVpnService } from './mobile_vpn'
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
  private persistLocal = false
  private generation = 0
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
    })
    this.configurationClient = { mode, connected, client }
    return client
  }

  constructor() {
    const platform = osType()
    this.snapshot = { platform, version: '', mode: loadMode(platform), connected: false, managementConnected: false, clientPaused: platform === 'android' && loadLocalClientPaused(), serviceStatus: 'NotInstalled', busy: false, revision: 0 }
  }
  getSnapshot = (): SessionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.subscribers.add(listener); return () => this.subscribers.delete(listener) }
  private patch(update: Partial<SessionSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...update, revision: this.snapshot.revision + 1 }
    this.subscribers.forEach(listener => listener())
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
        if (this.snapshot.platform === 'android') this.retainCleanup(await initMobileVpnService())
        if (this.disposed) return
        this.retainCleanup(await listenGlobalEvents({
          android: this.snapshot.platform === 'android', persist: () => this.persistLocal,
          changed: () => this.patch({}), error: code => this.patch({ errorCode: code }),
        }))
        this.patch({ version: await backend.getEasytierVersion() })
        if (this.disposed) return
        if (this.snapshot.clientPaused) await this.pauseLocalClient()
        else {
          if (this.snapshot.platform === 'android') await resumeMobileVpnService()
          await this.connect(cloneMode(this.snapshot.mode))
        }
        if (this.snapshot.platform === 'android') {
          setMobileVpnTileActionHandler(async action => {
            if (action === 'stop') { await this.stopLocalClient(); return }
            if (this.snapshot.clientPaused) { await this.startLocalClient(); return }
            const result = await executeVpnTileAction(action, this.remoteClient, { lastInstanceId: loadLastNetworkInstanceId(), syncVpnService: syncMobileVpnService })
            if (result.instanceId) saveLastNetworkInstanceId(result.instanceId)
            else this.patch({ errorCode: 'vpn_tile_no_network' })
            this.patch({})
          })
          this.cleanups.push(() => setMobileVpnTileActionHandler())
          await syncMobileVpnService()
        }
      } catch { this.patch({ connected: false, errorCode: this.snapshot.clientPaused ? this.snapshot.errorCode || 'client_stop_failed' : 'client_initialization_failed' }) }
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
    const enabled = mode.mode === 'normal' ? [...new Set([...liveIds, ...loadEnabledNetworks().filter(id => localIds.has(id))])] : []
    await backend.sendConfigs(enabled, mode.mode === 'remote' || supportsUplinkSelectionForOs(this.snapshot.platform))
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
    this.patch({ mode, connected: true, errorCode: mode.config_server_needs_credentials ? 'config_server_credentials_required' : undefined,
      serviceStatus: this.snapshot.platform === 'android' ? 'NotInstalled' : await backend.getServiceStatus().catch(() => 'NotInstalled' as const) })
  }
  applyMode(mode: Mode): Promise<void> {
    const requested = cloneMode(mode)
    return this.serial(async () => {
      if (this.snapshot.clientPaused) {
        this.assertLocalAndroid()
        if (requested.mode !== 'normal') throw new Error('mode_not_supported')
        saveMode(requested)
        this.patch({ mode: requested, errorCode: this.localStopIncomplete ? 'client_stop_failed' : undefined })
        return
      }
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
          this.patch({ connected: false, managementConnected: false, serviceStatus: previousServiceStatus,
            errorCode: this.snapshot.errorCode || 'mode_apply_failed' })
        } else {
          try { await this.connect(previous) } catch { this.patch({ connected: false }) }
          this.patch({ errorCode: serviceFailure ? error.message : 'mode_apply_failed' })
        }
        throw new Error(this.snapshot.errorCode || 'mode_apply_failed')
      }
    })
  }
  reconnect(): Promise<void> { return this.snapshot.clientPaused ? this.startLocalClient() : this.applyMode(this.snapshot.mode) }
  private assertLocalAndroid() {
    if (this.snapshot.platform !== 'android' || this.snapshot.mode.mode !== 'normal') throw new Error('mode_not_supported')
  }
  private async pauseLocalClient() {
    this.assertLocalAndroid()
    this.manuallyStopped = true
    saveLocalClientPaused(true)
    this.patch({ clientPaused: true, connected: false, managementConnected: false })
    // Attempt both effects even if one fails. Neither a stopped TUN alone nor
    // a disconnected management agent alone means the client is fully stopped.
    const vpn = suspendMobileVpnService()
    const core = backend.stopLocalClient()
    const results = await Promise.allSettled([vpn, core])
    if (results.some(result => result.status === 'rejected')) {
      this.localStopIncomplete = true
      this.patch({ errorCode: 'client_stop_failed' })
      throw new Error('client_stop_failed')
    }
    this.localStopIncomplete = false
    this.patch({ errorCode: undefined })
  }
  stopLocalClient(): Promise<void> {
    return this.serial(() => this.pauseLocalClient())
  }
  startLocalClient(): Promise<void> {
    return this.serial(async () => {
      this.assertLocalAndroid()
      try {
        if (this.localStopIncomplete) await this.pauseLocalClient()
        await backend.resumeLocalClient()
        await resumeMobileVpnService()
        await this.connect(cloneMode(this.snapshot.mode))
        await syncMobileVpnService({ strict: true })
        saveLocalClientPaused(false)
        this.patch({ clientPaused: false })
      } catch {
        try { await this.pauseLocalClient() }
        catch { throw new Error('client_stop_failed') }
        this.patch({ errorCode: 'client_start_failed' })
        throw new Error('client_start_failed')
      }
    })
  }
  stopService(): Promise<void> {
    return this.serial(async () => {
      this.manuallyStopped = true
      try { await backend.setServiceStatus(false); this.patch({ connected: false, serviceStatus: 'Stopped' }) }
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
      if (this.snapshot.clientPaused) { this.schedulePoll(); return }
      if (!this.snapshot.busy) {
        const generation = this.generation
        const connected = await backend.isClientRunning().catch(() => false)
        const managementConnected = this.snapshot.mode.mode === 'normal' && !!this.snapshot.mode.config_server_url
          ? await backend.isWebClientConnected().catch(() => false) : false
        if (this.disposed) return
        if (generation !== this.generation || this.snapshot.busy) { this.schedulePoll(); return }
        const shouldReconnect = !connected && !this.manuallyStopped && Date.now() >= this.retryAt
        if (connected !== this.snapshot.connected || managementConnected !== this.snapshot.managementConnected) this.patch({ connected, managementConnected })
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
