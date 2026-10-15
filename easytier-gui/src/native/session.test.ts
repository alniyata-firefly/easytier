import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  platform: 'windows', mode: { mode: 'normal' } as Record<string, unknown>,
  configs: [] as Array<{ config: { instance_id: string }; source: string }>, enabled: [] as string[],
  running: true, status: 'NotInstalled',
  paused: false,
  stopLocalClient: vi.fn(), resumeLocalClient: vi.fn(), suspendMobileVpnService: vi.fn(), resumeMobileVpnService: vi.fn(),
  consumePendingMobileVpnTileAction: vi.fn(),
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
  listNetworkInstanceIds: async () => ({ running_inst_ids: [], disabled_inst_ids: [] }),
  stopLocalClient: fixture.stopLocalClient, resumeLocalClient: fixture.resumeLocalClient,
}))
vi.mock('./storage', () => ({
  loadMode: () => fixture.mode, saveMode: fixture.saveMode, loadStoredConfigs: () => fixture.configs,
  loadEnabledNetworks: () => fixture.enabled, loadLastNetworkInstanceId: () => undefined, saveLastNetworkInstanceId: vi.fn(),
  loadLocalClientPaused: () => fixture.paused, saveLocalClientPaused: (paused: boolean) => { fixture.paused = paused },
}))
vi.mock('./client', () => ({ GUIRemoteClient: class {} }))
vi.mock('./events', () => ({ listenGlobalEvents: fixture.listen }))
vi.mock('./mobile_vpn', () => ({
  initMobileVpnService: async () => fixture.mobileCleanup, disposeMobileVpnService: fixture.mobileCleanup,
  consumePendingMobileVpnTileAction: fixture.consumePendingMobileVpnTileAction,
  setMobileVpnTileActionHandler: (handler?: typeof fixture.tileHandler) => { fixture.tileHandler = handler },
  syncMobileVpnService: async () => undefined,
  suspendMobileVpnService: fixture.suspendMobileVpnService, resumeMobileVpnService: fixture.resumeMobileVpnService,
}))
vi.mock('./mobile_vpn_tile', () => ({ executeVpnTileAction: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  fixture.platform = 'windows'
  fixture.mode = { mode: 'normal' }
  fixture.configs = []
  fixture.enabled = []
  fixture.status = 'NotInstalled'
  fixture.running = true
  fixture.paused = false
  fixture.tileHandler = undefined
  fixture.stopLocalClient.mockReset().mockResolvedValue(undefined)
  fixture.resumeLocalClient.mockReset().mockResolvedValue(undefined)
  fixture.suspendMobileVpnService.mockReset().mockResolvedValue(undefined)
  fixture.consumePendingMobileVpnTileAction.mockReset().mockResolvedValue(false)
  fixture.listen.mockResolvedValue(fixture.cleanup)
  fixture.initRpcConnection.mockResolvedValue(undefined)
  fixture.sendConfigs.mockResolvedValue(undefined)
  fixture.initWebClient.mockResolvedValue(undefined)
  fixture.isClientRunning.mockImplementation(async () => fixture.running)
  fixture.getServiceStatus.mockImplementation(async () => fixture.status)
  fixture.initService.mockImplementation(async (opts?: unknown) => { fixture.status = opts ? 'Stopped' : 'NotInstalled' })
  fixture.setServiceStatus.mockImplementation(async (enabled: boolean) => { fixture.status = enabled ? 'Running' : 'Stopped'; fixture.running = enabled })
})

describe('native client lifecycle boundaries', () => {
  it('pauses the whole Android client without forgetting management credentials or enabled instances', async () => {
    fixture.platform = 'android'
    fixture.mode = { mode: 'normal', config_server_url: 'udp://example.invalid:22020/fixture-token' }
    fixture.configs = [{ config: { instance_id: 'local-id' }, source: 'user' }, { config: { instance_id: 'web-id' }, source: 'web' }]
    fixture.enabled = ['local-id', 'web-id']
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    const rpcCalls = fixture.initRpcConnection.mock.calls.length
    await session.stopLocalClient()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, connected: false, managementConnected: false, errorCode: undefined })
    expect(fixture.paused).toBe(true)
    expect(fixture.enabled).toEqual(['local-id', 'web-id'])
    expect(session.getSnapshot().mode.config_server_url).toBe('udp://example.invalid:22020/fixture-token')
    await vi.advanceTimersByTimeAsync(60000)
    expect(fixture.initRpcConnection).toHaveBeenCalledTimes(rpcCalls)
    await session.startLocalClient()
    expect(fixture.resumeLocalClient).toHaveBeenCalledOnce()
    expect(fixture.initWebClient).toHaveBeenLastCalledWith('udp://example.invalid:22020/fixture-token')
    expect(fixture.sendConfigs).toHaveBeenLastCalledWith(['local-id'], false)
    expect(session.getSnapshot()).toMatchObject({ clientPaused: false, connected: true, errorCode: undefined })
    expect(fixture.paused).toBe(false)
    session.dispose()
  })

  it('keeps Android paused across a WebView/session reload until Start is explicit', async () => {
    fixture.platform = 'android'
    fixture.paused = true
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.initRpcConnection).not.toHaveBeenCalled()
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    expect(session.getSnapshot().clientPaused).toBe(true)
    await session.applyMode({ mode: 'normal', config_server_url: 'udp://updated.invalid:22020/new-fixture-token' })
    expect(fixture.initWebClient).not.toHaveBeenCalled()
    await session.reconnect()
    expect(fixture.initWebClient).toHaveBeenLastCalledWith('udp://updated.invalid:22020/new-fixture-token')
    session.dispose()
  })

  it('stops Android locally even when RPC and the management server are unreachable', async () => {
    fixture.platform = 'android'
    fixture.mode = { mode: 'normal', config_server_url: 'udp://offline.invalid:22020/retained-token' }
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    const rpcCalls = fixture.initRpcConnection.mock.calls.length
    const managementCalls = fixture.initWebClient.mock.calls.length
    fixture.running = false
    fixture.initRpcConnection.mockRejectedValue(new Error('fixture offline RPC'))
    fixture.initWebClient.mockRejectedValue(new Error('fixture offline management'))
    await session.stopLocalClient()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(fixture.initRpcConnection).toHaveBeenCalledTimes(rpcCalls)
    expect(fixture.initWebClient).toHaveBeenCalledTimes(managementCalls)
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, errorCode: undefined })
    expect(session.getSnapshot().mode.config_server_url).toBe('udp://offline.invalid:22020/retained-token')
    session.dispose()
  })

  it('reports incomplete Core stop and leaves Android paused with a working retry', async () => {
    fixture.platform = 'android'
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.stopLocalClient.mockRejectedValueOnce(new Error('fixture native stop still running'))
    await expect(session.stopLocalClient()).rejects.toThrow('client_stop_failed')
    expect(fixture.suspendMobileVpnService).toHaveBeenCalledOnce()
    expect(session.getSnapshot()).toMatchObject({ clientPaused: true, connected: false, errorCode: 'client_stop_failed', busy: false })
    await session.stopLocalClient()
    expect(session.getSnapshot().errorCode).toBeUndefined()
    await session.startLocalClient()
    expect(session.getSnapshot().clientPaused).toBe(false)
    session.dispose()
  })

  it('still stops Core when the Android VPN service cannot confirm release', async () => {
    fixture.platform = 'android'
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    fixture.suspendMobileVpnService.mockRejectedValueOnce(new Error('fixture service failure'))
    await expect(session.stopLocalClient()).rejects.toThrow('client_stop_failed')
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot().errorCode).toBe('client_stop_failed')
    session.dispose()
  })

  it('routes the Android quick-settings Stop through the same client lifecycle', async () => {
    fixture.platform = 'android'
    fixture.consumePendingMobileVpnTileAction.mockImplementationOnce(async () => {
      await fixture.tileHandler?.('stop')
      return true
    })
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
    expect(fixture.stopLocalClient).toHaveBeenCalledOnce()
    expect(session.getSnapshot().clientPaused).toBe(true)
    await fixture.tileHandler?.('start')
    expect(session.getSnapshot().clientPaused).toBe(false)
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
    expect(fixture.sendConfigs).toHaveBeenCalledWith(['user-id'], true)
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
    expect(fixture.sendConfigs).toHaveBeenCalledWith([], true)
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
    const { NativeSession } = await import('./session')
    const session = new NativeSession()
    await session.initialize()
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
