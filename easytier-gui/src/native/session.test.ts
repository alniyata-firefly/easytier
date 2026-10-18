import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  platform: 'windows', mode: { mode: 'normal' } as Record<string, unknown>,
  configs: [] as Array<{ config: { instance_id: string }; source: string }>, enabled: [] as string[],
  running: true, status: 'NotInstalled',
  managementState: 'authorized',
  paused: false,
  nativeEnabled: true, vpnConnected: false,
  vpnError: undefined as string | undefined,
  vpnFailure: undefined as string | undefined,
  cancelPendingMobileVpnStart: vi.fn(),
  stopLocalClient: vi.fn(), resumeLocalClient: vi.fn(), suspendMobileVpnService: vi.fn(), resumeMobileVpnService: vi.fn(),
  consumePendingMobileVpnTileAction: vi.fn(), syncMobileVpnService: vi.fn(),
  initMobileManagementService: vi.fn(), observeMobileVpnService: vi.fn(),
  executeVpnTileAction: vi.fn(),
  waitForMobileVpnInstance: vi.fn(),
  tileHandler: undefined as undefined | ((action: 'start' | 'stop') => Promise<void>),
  initRpcConnection: vi.fn(), sendConfigs: vi.fn(), initWebClient: vi.fn(), saveMode: vi.fn(),
  getServiceStatus: vi.fn(), initService: vi.fn(), setServiceStatus: vi.fn(),
  isClientRunning: vi.fn(), listen: vi.fn(), cleanup: vi.fn(), mobileCleanup: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => fixture.platform }))
vi.mock('../../../easytier-web/frontend-lib/src/modules/utils', () => ({ UuidToStr: (id: unknown) => String(id) }))
vi.mock('./backend', () => ({
  getEasytierVersion: async () => 'fixture-version', initRpcConnection: fixture.initRpcConnection,
  sendConfigs: fixture.sendConfigs, initWebClient: fixture.initWebClient, getServiceStatus: fixture.getServiceStatus,
  initService: fixture.initService, setServiceStatus: fixture.setServiceStatus,
  isClientRunning: fixture.isClientRunning, isWebClientConnected: async () => true,
  getWebClientStatus: async () => fixture.managementState,
  listNetworkInstanceIds: async () => ({ running_inst_ids: [], disabled_inst_ids: [] }),
  stopLocalClient: fixture.stopLocalClient, resumeLocalClient: fixture.resumeLocalClient,
  isLocalClientEnabled: async () => fixture.nativeEnabled,
}))
vi.mock('./storage', () => ({
  loadMode: () => fixture.mode, saveMode: fixture.saveMode, loadStoredConfigs: () => fixture.configs,
  loadEnabledNetworks: () => fixture.enabled, loadLastNetworkInstanceId: () => undefined, saveLastNetworkInstanceId: vi.fn(),
  loadLocalClientPaused: () => fixture.paused, saveLocalClientPaused: (paused: boolean) => { fixture.paused = paused },
}))
vi.mock('./client', () => ({ GUIRemoteClient: class {} }))
vi.mock('./events', () => ({ listenGlobalEvents: fixture.listen }))
vi.mock('./mobile_vpn', () => ({
  cancelPendingMobileVpnStart: fixture.cancelPendingMobileVpnStart,
  initMobileVpnService: async () => fixture.mobileCleanup, disposeMobileVpnService: fixture.mobileCleanup,
  consumePendingMobileVpnTileAction: fixture.consumePendingMobileVpnTileAction,
  setMobileVpnTileActionHandler: (handler?: typeof fixture.tileHandler) => { fixture.tileHandler = handler },
  syncMobileVpnService: fixture.syncMobileVpnService,
  initMobileManagementService: fixture.initMobileManagementService, observeMobileVpnService: fixture.observeMobileVpnService,
  suspendMobileVpnService: fixture.suspendMobileVpnService, resumeMobileVpnService: fixture.resumeMobileVpnService,
  isMobileVpnConnected: async () => fixture.vpnConnected,
  getMobileVpnError: () => fixture.vpnError,
  getMobileVpnFailureCode: () => fixture.vpnFailure,
  waitForMobileVpnInstance: fixture.waitForMobileVpnInstance,
}))
vi.mock('./mobile_vpn_tile', () => ({ executeVpnTileAction: fixture.executeVpnTileAction }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllTimers()
  vi.resetModules()
  vi.clearAllMocks()
  fixture.platform = 'windows'
  fixture.mode = { mode: 'normal' }
  fixture.configs = []
  fixture.enabled = []
  fixture.status = 'NotInstalled'
  fixture.running = true
  fixture.managementState = 'authorized'
  fixture.paused = false
  fixture.nativeEnabled = true
  fixture.vpnConnected = false
  fixture.vpnError = undefined
  fixture.vpnFailure = undefined
  fixture.tileHandler = undefined
  fixture.cancelPendingMobileVpnStart.mockReset()
  fixture.stopLocalClient.mockReset().mockImplementation(async () => { fixture.nativeEnabled = false })
  fixture.resumeLocalClient.mockReset().mockImplementation(async () => { fixture.nativeEnabled = true })
  fixture.suspendMobileVpnService.mockReset().mockResolvedValue(undefined)
  fixture.consumePendingMobileVpnTileAction.mockReset().mockResolvedValue(false)
  fixture.syncMobileVpnService.mockReset().mockResolvedValue(undefined)
  fixture.initMobileManagementService.mockReset().mockResolvedValue(undefined)
  fixture.observeMobileVpnService.mockReset().mockImplementation(async () => fixture.vpnConnected)
  fixture.executeVpnTileAction.mockReset().mockImplementation(async (action, _client, options) => {
    await options.syncVpnService('fixture-network')
    return { action, instanceId: 'fixture-network', changed: false }
  })
  fixture.listen.mockResolvedValue(fixture.cleanup)
  fixture.initRpcConnection.mockImplementation(async () => { fixture.running = true })
  fixture.sendConfigs.mockResolvedValue(undefined)
  fixture.initWebClient.mockResolvedValue(undefined)
  fixture.isClientRunning.mockImplementation(async () => fixture.running)
  fixture.getServiceStatus.mockImplementation(async () => fixture.status)
  fixture.initService.mockImplementation(async (opts?: unknown) => { fixture.status = opts ? 'Stopped' : 'NotInstalled' })
  fixture.setServiceStatus.mockImplementation(async (enabled: boolean) => { fixture.status = enabled ? 'Running' : 'Stopped'; fixture.running = enabled })
})

describe('native client lifecycle boundaries', () => {
  it('cancels a queued Connect before it starts without resuming VPN or reporting a failure', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    const connecting = expect(session.startLocalClient()).rejects.toThrow('vpn_request_canceled')
    const stopping = session.stopLocalClient()
    expect(fixture.cancelPendingMobileVpnStart).toHaveBeenCalledOnce()
    await Promise.all([connecting, stopping])
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    expect(fixture.resumeMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.executeVpnTileAction).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, vpnConnected: false, errorCode: undefined, vpnFailureCode: undefined })
    session.dispose()
  })

  it('does not resume JS VPN intent when an older native Resume returns after Disconnect', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    let releaseResume!: () => void
    fixture.resumeLocalClient.mockImplementationOnce(() => new Promise<void>(resolve => { releaseResume = resolve }))
    const connecting = expect(session.startLocalClient()).rejects.toThrow('vpn_request_canceled')
    await vi.waitFor(() => expect(fixture.resumeLocalClient).toHaveBeenCalledOnce())
    const stopping = session.stopLocalClient()
    expect(fixture.cancelPendingMobileVpnStart).toHaveBeenCalledOnce()
    expect(fixture.stopLocalClient).not.toHaveBeenCalled()
    releaseResume()
    await Promise.all([connecting, stopping])
    expect(fixture.resumeMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.executeVpnTileAction).not.toHaveBeenCalled()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, vpnConnected: false, errorCode: undefined, vpnFailureCode: undefined })
    session.dispose()
  })

  it('invalidates native confirmation before queued cleanup, without treating explicit cancellation as a VPN failure', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    let cancelConfirmation!: (error: Error) => void
    fixture.syncMobileVpnService.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { cancelConfirmation = reject }))
    const connecting = expect(session.startLocalClient()).rejects.toThrow('vpn_request_canceled')
    await vi.waitFor(() => expect(fixture.syncMobileVpnService).toHaveBeenCalledOnce())
    fixture.cancelPendingMobileVpnStart.mockImplementationOnce(() => cancelConfirmation(new Error('vpn_request_canceled')))
    const stopping = session.stopLocalClient()
    await Promise.all([connecting, stopping])
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, vpnConnected: false, busy: false, errorCode: undefined, vpnFailureCode: undefined })
    session.dispose()
  })

  it('still cleans up a native request cancellation when no newer user intent queued a Stop', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.vpnError = 'vpn_tun_fd_failed'
    fixture.vpnFailure = 'vpn_tun_request_stale'
    fixture.syncMobileVpnService.mockRejectedValueOnce(new Error('vpn_request_canceled'))
    await expect(session.startLocalClient()).rejects.toThrow('client_start_failed')
    expect(fixture.cancelPendingMobileVpnStart).not.toHaveBeenCalled()
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ vpnConnected: false, clientPaused: true,
      errorCode: 'client_start_failed', vpnFailureCode: 'vpn_tun_request_stale' })
    session.dispose()
  })

  it('preserves a safe Core failure before cleanup clears native errors, including failed cleanup', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.syncMobileVpnService.mockImplementationOnce(async () => {
      fixture.vpnError = 'vpn_tun_fd_failed'
      fixture.vpnFailure = 'vpn_core_install_timeout'
      throw new Error('vpn_tun_fd_failed')
    })
    fixture.suspendMobileVpnService.mockImplementationOnce(async () => {
      fixture.vpnError = undefined
      fixture.vpnFailure = undefined
      throw new Error('cleanup contains private credentials')
    })
    await expect(session.startLocalClient()).rejects.toThrow('client_stop_failed')
    expect(session.getSnapshot()).toMatchObject({ vpnFailureCode: 'vpn_core_install_timeout', errorCode: 'client_stop_failed', vpnStopIncomplete: true })
    expect(JSON.stringify(session.getSnapshot())).not.toContain('cleanup contains private credentials')
    session.dispose()
  })

  it('retains the VPN diagnosis across management failures and clears it for retry, success and explicit disconnect', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.syncMobileVpnService.mockRejectedValueOnce(new Error('vpn_tun_start_failed'))
    await expect(session.startLocalClient()).rejects.toThrow('client_start_failed')
    expect(session.getSnapshot().vpnFailureCode).toBe('vpn_tun_start_failed')
    fixture.initWebClient.mockRejectedValueOnce(new Error('management-secret'))
    await expect(session.reconnect()).rejects.toThrow('mode_apply_failed')
    expect(session.getSnapshot().vpnFailureCode).toBe('vpn_tun_start_failed')
    fixture.resumeLocalClient.mockImplementationOnce(async () => {
      expect(session.getSnapshot().vpnFailureCode).toBeUndefined()
      fixture.nativeEnabled = true
    })
    fixture.syncMobileVpnService.mockImplementationOnce(async () => { fixture.vpnConnected = true })
    await session.startLocalClient()
    expect(session.getSnapshot()).toMatchObject({ vpnConnected: true, vpnFailureCode: undefined })
    await session.stopLocalClient()
    expect(session.getSnapshot().vpnFailureCode).toBeUndefined()
    session.dispose()
  })

  it('captures polling and warm-resume failures before automatic pause resets the native error', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.vpnConnected = true
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.vpnConnected = false
    fixture.vpnError = 'vpn_tun_fd_failed'
    fixture.vpnFailure = 'vpn_tun_descriptor_unavailable'
    fixture.suspendMobileVpnService.mockImplementationOnce(async () => { fixture.vpnError = undefined; fixture.vpnFailure = undefined })
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, vpnFailureCode: 'vpn_tun_descriptor_unavailable', errorCode: 'client_start_failed' })
    await session.stopLocalClient()
    expect(session.getSnapshot().vpnFailureCode).toBeUndefined()
    session.dispose()
  })

  it('keeps warm-start diagnosis and never retains arbitrary exception text as a failure code', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.syncMobileVpnService.mockRejectedValueOnce(new Error('vpn_foreground_start_failed'))
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(session.getSnapshot().vpnFailureCode).toBe('vpn_foreground_start_failed')
    fixture.vpnError = 'udp://private.invalid/secret-token'
    fixture.vpnFailure = 'password=private-value'
    fixture.resumeLocalClient.mockRejectedValueOnce(new Error('raw-sensitive-token'))
    await expect(session.startLocalClient()).rejects.toThrow('client_start_failed')
    expect(session.getSnapshot().vpnFailureCode).toBe('vpn_start_failed')
    expect(JSON.stringify(session.getSnapshot())).not.toMatch(/secret-token|private-value|raw-sensitive-token/)
    session.dispose()
  })

  it('does not assign Android VPN failure diagnostics to desktop management errors', async () => {
    fixture.platform = 'windows'
    fixture.initWebClient.mockRejectedValueOnce(new Error('vpn_tun_start_failed'))
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(session.getSnapshot().vpnFailureCode).toBeUndefined()
    session.dispose()
  })

  it('does not classify Android management initialization errors as local VPN failures', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.running = false
    fixture.initWebClient.mockRejectedValueOnce(new Error('vpn_tun_start_failed'))
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(session.getSnapshot().errorCode).toBe('client_initialization_failed')
    expect(session.getSnapshot().vpnFailureCode).toBeUndefined()
    session.dispose()
  })

  it('connects management on Android App launch while saved VPN intent cannot start the VPN', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.running = false
    fixture.paused = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    fixture.configs = [{ config: { instance_id: 'user-id' }, source: 'user' }]
    fixture.enabled = ['user-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fixture.initRpcConnection).toHaveBeenCalledOnce()
    expect(fixture.initWebClient).toHaveBeenCalledWith('udp://example.invalid:22020/fixture-token')
    expect(fixture.initMobileManagementService).toHaveBeenCalledOnce()
    expect(fixture.sendConfigs).toHaveBeenCalledWith([], false, true)
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    expect(fixture.resumeMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.syncMobileVpnService).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false })
    session.dispose()
  })

  it('keeps management authentication, rejection and pending approval independent of VPN state', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    for (const state of ['authenticating', 'pending_approval', 'rejected', 'authorized']) {
      fixture.managementState = state
      await vi.advanceTimersByTimeAsync(2000)
      expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: state === 'authorized', managementState: state, clientPaused: true, vpnConnected: false })
    }
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    session.dispose()
  })

  it('connects and disconnects VPN without reinitializing management or forgetting configurations', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    fixture.enabled = ['local-id', 'web-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(2000)
    const rpcCalls = fixture.initRpcConnection.mock.calls.length
    const managementCalls = fixture.initWebClient.mock.calls.length
    fixture.syncMobileVpnService.mockImplementationOnce(async () => { fixture.vpnConnected = true })
    await session.startLocalClient()
    expect(fixture.syncMobileVpnService).toHaveBeenLastCalledWith({ strict: true, preferredInstanceId: 'fixture-network' })
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: false, vpnConnected: true })
    await session.stopLocalClient()
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, managementState: 'authorized', clientPaused: true, vpnConnected: false })
    expect(fixture.initRpcConnection).toHaveBeenCalledTimes(rpcCalls)
    expect(fixture.initWebClient).toHaveBeenCalledTimes(managementCalls)
    expect(fixture.enabled).toEqual(['local-id', 'web-id'])
    expect(session.getSnapshot().mode.config_server_url).toBe('udp://example.invalid:22020/fixture-token')
    session.dispose()
  })

  it('allows management settings changes and reconnection while VPN remains disconnected', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await session.applyMode({ mode: 'normal', config_server_url: 'udp://updated.invalid:22020/fixture-token' })
    expect(fixture.initWebClient).toHaveBeenLastCalledWith('udp://updated.invalid:22020/fixture-token')
    await session.reconnect()
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    expect(fixture.resumeMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.syncMobileVpnService).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ connected: true, clientPaused: true, vpnConnected: false })
    session.dispose()
  })

  it('reattaches to a live Android VPN without reconnecting management or rebuilding TUN', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.vpnConnected = true
    fixture.paused = true
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: false, vpnConnected: true })
    expect(fixture.observeMobileVpnService).toHaveBeenCalled()
    for (const action of [fixture.resumeLocalClient, fixture.stopLocalClient, fixture.suspendMobileVpnService,
      fixture.initRpcConnection, fixture.sendConfigs, fixture.initWebClient, fixture.syncMobileVpnService]) expect(action).not.toHaveBeenCalled()
    session.dispose()
  })

  it('retains a live VPN through management disconnection and reauthentication after a network change', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.vpnConnected = true
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    for (const state of ['disconnected', 'connecting', 'authenticating', 'authorized']) {
      fixture.managementState = state
      await vi.advanceTimersByTimeAsync(2000)
      expect(session.getSnapshot()).toMatchObject({ vpnConnected: true, clientPaused: false, managementConnected: state === 'authorized', managementState: state })
      expect(fixture.stopLocalClient).not.toHaveBeenCalled()
      expect(fixture.suspendMobileVpnService).not.toHaveBeenCalled()
      expect(fixture.initWebClient).not.toHaveBeenCalled()
    }
    session.dispose()
  })

  it('resumes an unfinished warm VPN connection without reinitializing management', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.syncMobileVpnService).toHaveBeenCalledOnce()
    expect(fixture.initRpcConnection).not.toHaveBeenCalled()
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ connected: true, clientPaused: false, vpnConnected: false, vpnTransition: 'connecting' })
    fixture.vpnConnected = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.getSnapshot()).toMatchObject({ vpnConnected: true, vpnTransition: undefined })
    session.dispose()
  })

  it('continues waiting for controller configuration after a warm remount with no Core running yet', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.waitForMobileVpnInstance).toHaveBeenCalledOnce()
    expect(fixture.waitForMobileVpnInstance.mock.calls[0]).toEqual([])
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: false, vpnTransition: 'connecting' })
    session.dispose()
  })

  it('retains management when an unfinished warm VPN connection cannot resume', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    fixture.syncMobileVpnService.mockRejectedValueOnce(new Error('fixture native start failed'))
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, errorCode: 'client_start_failed' })
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    session.dispose()
  })

  it('adopts system VPN revocation without disconnecting management or restarting the VPN', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.vpnConnected = true
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.nativeEnabled = false
    fixture.vpnError = 'vpn_permission_revoked'
    await vi.advanceTimersByTimeAsync(10000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false, errorCode: 'vpn_permission_revoked' })
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.syncMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    session.dispose()
  })

  it('does not warm-resume a VPN revoked before the old WebView could attach Core', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.running = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    fixture.observeMobileVpnService.mockImplementationOnce(async () => {
      fixture.vpnError = 'vpn_permission_revoked'
      return false
    })
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false, errorCode: 'vpn_permission_revoked' })
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.syncMobileVpnService).not.toHaveBeenCalled()
    expect(fixture.initWebClient).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('disconnects a failed background VPN reconciliation while retaining management', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await session.startLocalClient()
    fixture.vpnError = 'vpn_tun_fd_failed'
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false, vpnTransition: undefined, errorCode: 'client_start_failed' })
    session.dispose()
  })

  it('ends a VPN connection that never acquires an address instead of remaining pending forever', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await session.startLocalClient()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: false, vpnTransition: 'connecting' })
    await vi.advanceTimersByTimeAsync(152000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false, vpnTransition: undefined, errorCode: 'vpn_connection_timeout', vpnFailureCode: 'vpn_connection_timeout' })
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    session.dispose()
  })

  it('retries failed management RPC while VPN stays disconnected', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.running = false
    fixture.initRpcConnection.mockRejectedValueOnce(new Error('fixture failed control RPC'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(session.getSnapshot()).toMatchObject({ connected: true, clientPaused: true, vpnConnected: false })
    expect(fixture.resumeLocalClient).not.toHaveBeenCalled()
    expect(fixture.resumeMobileVpnService).not.toHaveBeenCalled()
    session.dispose()
  })

  it('disconnects VPN while the controller is unreachable without using controller RPC', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = true
    fixture.vpnConnected = true
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.running = false
    fixture.initRpcConnection.mockRejectedValue(new Error('fixture offline RPC'))
    const managementCalls = fixture.initWebClient.mock.calls.length
    await session.stopLocalClient()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(fixture.initWebClient).toHaveBeenCalledTimes(managementCalls)
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, vpnConnected: false, errorCode: undefined })
    session.dispose()
  })

  it('keeps management online and supports retry when native VPN cleanup is incomplete', async () => {
    fixture.platform = 'android'
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.stopLocalClient.mockRejectedValueOnce(new Error('fixture pending detach'))
    await expect(session.stopLocalClient()).rejects.toThrow('client_stop_failed')
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnStopIncomplete: true, errorCode: 'client_stop_failed' })
    await session.reconnect()
    expect(session.getSnapshot().vpnStopIncomplete).toBe(true)
    await session.stopLocalClient()
    expect(session.getSnapshot()).toMatchObject({ connected: true, vpnStopIncomplete: false, errorCode: undefined })
    session.dispose()
  })

  it('rolls back failed VPN startup while retaining the management connection', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(2000)
    fixture.syncMobileVpnService.mockRejectedValueOnce(new Error('fixture permission denied'))
    await expect(session.startLocalClient()).rejects.toThrow('client_start_failed')
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: true, vpnConnected: false, errorCode: 'client_start_failed' })
    session.dispose()
  })

  it('waits for current managed configuration after Connect without starting a cached managed Core', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await vi.advanceTimersByTimeAsync(2000)
    fixture.executeVpnTileAction.mockResolvedValueOnce({ action: 'start', changed: false })
    await session.startLocalClient()
    expect(fixture.waitForMobileVpnInstance).toHaveBeenCalledWith(undefined)
    expect(session.getSnapshot()).toMatchObject({ connected: true, managementConnected: true, clientPaused: false, vpnConnected: false, vpnTransition: 'connecting' })
    session.dispose()
  })

  it('reports no available VPN when neither local configuration nor a controller is configured', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.executeVpnTileAction.mockResolvedValueOnce({ action: 'start', changed: false })
    await expect(session.startLocalClient()).rejects.toThrow('vpn_no_network')
    expect(session.getSnapshot()).toMatchObject({ connected: true, clientPaused: true, vpnConnected: false })
    session.dispose()
  })

  it('routes explicit Android Tile Connect through VPN lifecycle after management starts', async () => {
    fixture.platform = 'android'
    fixture.nativeEnabled = false
    fixture.running = false
    fixture.consumePendingMobileVpnTileAction.mockImplementationOnce(async () => { await fixture.tileHandler?.('start'); return true })
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.resumeLocalClient).toHaveBeenCalledOnce()
    expect(fixture.initWebClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ connected: true, clientPaused: false })
    session.dispose()
  })

  it('does not stop a desktop or service Core through the Android lifecycle', async () => {
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await expect(session.stopLocalClient()).rejects.toThrow('mode_not_supported')
    expect(fixture.stopLocalClient).not.toHaveBeenCalled()
    expect(fixture.suspendMobileVpnService).not.toHaveBeenCalled()
    session.dispose()
  })
  it('restores local enabled networks while leaving central networks to their server', async () => {
    fixture.configs = [{ config: { instance_id: 'user-id' }, source: 'user' }, { config: { instance_id: 'web-id' }, source: 'web' }]
    fixture.enabled = ['user-id', 'web-id', 'unknown-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.sendConfigs).toHaveBeenCalledWith(['user-id'], true, true)
    expect(session.getSnapshot().connected).toBe(true)
    session.dispose()
  })

  it('does not start local saved configurations against a remote core', async () => {
    fixture.mode = { mode: 'remote', remote_rpc_address: 'tcp://192.0.2.10:15888' }
    fixture.configs = [{ config: { instance_id: 'local-id' }, source: 'user' }]
    fixture.enabled = ['local-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.sendConfigs).toHaveBeenCalledWith([], true, false)
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    session.dispose()
  })

  it('cleans a listener registration that completes after disposal', async () => {
    let resolveListener!: (cleanup: () => void) => void
    let begun!: () => void
    const started = new Promise<void>(resolve => { begun = resolve })
    fixture.listen.mockImplementationOnce(async () => { begun(); return new Promise(resolve => { resolveListener = resolve }) })
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    const initializing = session.initialize()
    await started
    session.dispose()
    resolveListener(fixture.cleanup)
    await initializing
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(fixture.initRpcConnection).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries unavailable RPC with bounded backoff rather than stopping after one failure', async () => {
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.running = false
    fixture.initRpcConnection.mockRejectedValue(new Error('fixture network unavailable'))
    await vi.advanceTimersByTimeAsync(2200)
    const afterFirstRetry = fixture.initRpcConnection.mock.calls.length
    expect(afterFirstRetry).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.initRpcConnection.mock.calls.length).toBe(afterFirstRetry)
    fixture.running = true
    fixture.initRpcConnection.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.getSnapshot().connected).toBe(true)
    session.dispose()
  })

  it('does not reconnect a service after an explicit stop', async () => {
    fixture.mode = { mode: 'service', config_dir: 'fixture/config', file_log_dir: 'fixture/logs', file_log_level: 'warn', rpc_portal: '127.0.0.1:15888', installed_core_version: 'fixture-version' }
    fixture.status = 'Running'
    fixture.configs = [{ config: { instance_id: 'local-id' }, source: 'user' }]
    fixture.enabled = ['local-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.sendConfigs).toHaveBeenCalledWith([], true, false)
    await session.stopService()
    const connections = fixture.initRpcConnection.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(fixture.initRpcConnection.mock.calls.length).toBe(connections)
    expect(session.getSnapshot().serviceStatus).toBe('Stopped')
    session.dispose()
  })

  it('does not expose a credential-bearing backend error in snapshot or exception', async () => {
    const token = 'A'.repeat(43)
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.initWebClient.mockRejectedValueOnce(new Error(`udp://192.0.2.10:22020/${token}`))
    await expect(session.applyMode({ mode: 'normal', config_server_url: `udp://192.0.2.10:22020/${token}` })).rejects.toThrow(/^mode_apply_failed$/)
    expect(session.getSnapshot().errorCode).toBe('mode_apply_failed')
    expect(session.getSnapshot().mode.config_server_url).toBeUndefined()
    session.dispose()
  })

  it('restores an explicitly stopped service after switching mode fails without starting it', async () => {
    fixture.mode = { mode: 'service', config_dir: 'fixture/config', file_log_dir: 'fixture/logs', file_log_level: 'warn', rpc_portal: '127.0.0.1:15888', installed_core_version: 'fixture-version' }
    fixture.status = 'Running'
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    await session.stopService()
    fixture.initRpcConnection.mockRejectedValueOnce(new Error('fixture normal-mode startup failure'))
    fixture.setServiceStatus.mockClear()
    await expect(session.applyMode({ mode: 'normal' })).rejects.toThrow('mode_apply_failed')
    expect(fixture.status).toBe('Stopped')
    expect(fixture.setServiceStatus).not.toHaveBeenCalledWith(true)
    expect(session.getSnapshot().connected).toBe(false)
    session.dispose()
  })
})
