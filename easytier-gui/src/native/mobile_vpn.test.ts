import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => Promise<void>>()
  const configs = new Map<string, Record<string, unknown>>()
  const networkInfo = new Map<string, unknown>()

  return {
    listeners,
    configs,
    networkInfo,
    addPluginListener: vi.fn(async (_plugin: string, event: string, listener: (payload: unknown) => Promise<void>) => {
      listeners.set(event, listener)
      return { unregister: async () => { listeners.delete(event) } }
    }),
    collectNetworkInfo: vi.fn(async (instanceId: string) => ({
      info: { map: { [instanceId]: networkInfo.get(instanceId) } },
    })),
    consumeVpnTileAction: vi.fn(async () => ({})),
    getConfig: vi.fn(async (instanceId: string) => configs.get(instanceId)),
    getLocalVpnStatus: vi.fn<() => Promise<Record<string, unknown> | null>>(async () => null),
    isLocalVpnConnected: vi.fn(async () => false),
    getVpnStatus: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ running: false })),
    listNetworkInstanceIds: vi.fn<() => Promise<{ running_inst_ids: unknown[] }>>(async () => ({ running_inst_ids: [] })),
    prepareVpn: vi.fn(async () => ({ granted: true })),
    setTunFd: vi.fn(async () => undefined),
    clearTunFd: vi.fn(async (_instanceId: string, _requestId: string) => undefined),
    setClientEnabled: vi.fn(async (_enabled: boolean) => ({} as { errorMsg?: string })),
    startVpn: vi.fn(async (_request: Record<string, unknown>) => ({})),
    stopVpn: vi.fn(async () => {
      await listeners.get('vpn_service_stop')?.({})
      return {}
    }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: mocks.addPluginListener,
}))

vi.mock('../../../easytier-web/frontend-lib/src/modules/utils', () => ({
    UuidToStr: (value: unknown) => String(value),
    ipv4ToString: (address: { addr: string }) => address.addr,
}))

vi.mock('../../../tauri-plugin-vpnservice/guest-js/index', () => ({
  consume_vpn_tile_action: mocks.consumeVpnTileAction,
  get_vpn_status: mocks.getVpnStatus,
  prepare_vpn: mocks.prepareVpn,
  start_vpn: mocks.startVpn,
  stop_vpn: mocks.stopVpn,
  set_client_enabled: mocks.setClientEnabled,
}))

vi.mock('./backend', () => ({
  collectNetworkInfo: mocks.collectNetworkInfo,
  getLocalVpnStatus: mocks.getLocalVpnStatus,
  isLocalVpnConnected: mocks.isLocalVpnConnected,
  getConfig: mocks.getConfig,
  listNetworkInstanceIds: mocks.listNetworkInstanceIds,
  setTunFd: mocks.setTunFd,
  clearTunFd: mocks.clearTunFd,
}))

function setConfig(instanceId: string, noTun = false) {
  mocks.configs.set(instanceId, {
    no_tun: noTun,
    dhcp: false,
    enable_magic_dns: false,
    routes: [],
  })
}

function setReady(instanceId: string, ipv4: string) {
  mocks.networkInfo.set(instanceId, {
    my_node_info: {
      virtual_ipv4: {
        address: { addr: ipv4 },
        network_length: 24,
      },
    },
    routes: [],
  })
}

async function loadVpnModule(resume = true) {
  const mobileVpn = await import('./mobile_vpn')
  await mobileVpn.initMobileVpnService()
  if (resume) await mobileVpn.resumeMobileVpnService()
  return mobileVpn
}

async function nativeEstablished(request: Record<string, unknown>, fd = 1, notify = true) {
  const snapshot = { ...request, state: 'established', running: true, established: true, fd }
  mocks.getVpnStatus.mockResolvedValue(snapshot)
  if (notify) await mocks.listeners.get('vpn_service_start')?.(snapshot)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllTimers()
  vi.resetModules()
  mocks.listeners.clear()
  mocks.configs.clear()
  mocks.networkInfo.clear()
  mocks.addPluginListener.mockClear()
  mocks.collectNetworkInfo.mockClear()
  mocks.consumeVpnTileAction.mockReset()
  mocks.consumeVpnTileAction.mockResolvedValue({})
  mocks.getConfig.mockClear()
  mocks.getLocalVpnStatus.mockReset().mockResolvedValue(null)
  mocks.isLocalVpnConnected.mockReset().mockResolvedValue(false)
  mocks.getVpnStatus.mockReset()
  mocks.getVpnStatus.mockResolvedValue({ running: false, state: 'stopped' })
  mocks.listNetworkInstanceIds.mockReset()
  mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: [] })
  mocks.prepareVpn.mockReset()
  mocks.prepareVpn.mockResolvedValue({ granted: true })
  mocks.setTunFd.mockReset()
  mocks.setTunFd.mockResolvedValue(undefined)
  mocks.setTunFd.mockClear()
  mocks.clearTunFd.mockReset().mockResolvedValue(undefined)
  mocks.setClientEnabled.mockReset().mockResolvedValue({})
  mocks.startVpn.mockReset().mockImplementation(async request => { await nativeEstablished(request); return {} })
  mocks.stopVpn.mockReset()
  mocks.stopVpn.mockImplementation(async () => {
    mocks.getVpnStatus.mockResolvedValue({ running: false, state: 'stopped' })
    await mocks.listeners.get('vpn_service_stop')?.({})
    return {}
  })
})

describe('management and OS VPN intent are independent', () => {
  it('waits for a current managed Core after explicit Connect, skips no_tun events and uses its fresh IP', async () => {
    const vpn = await loadVpnModule()
    vpn.waitForMobileVpnInstance()
    setConfig('relay', true); setReady('relay', '10.0.0.1')
    await vpn.onNetworkInstanceChange('relay', { passive: true })
    expect(mocks.startVpn).not.toHaveBeenCalled()
    setConfig('current'); setReady('current', '10.8.0.2')
    await vpn.onNetworkInstanceChange('current', { passive: true })
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'current', ipv4Addr: '10.8.0.2/24' }))
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
  })

  it('reconciles the selected managed instance once it exists even if its post_run event was missed', async () => {
    const vpn = await loadVpnModule()
    setConfig('selected')
    vpn.waitForMobileVpnInstance('selected')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.startVpn).not.toHaveBeenCalled()
    setReady('selected', '10.8.0.2')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['selected'] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'selected', ipv4Addr: '10.8.0.2/24' }))
  })

  it('cancels a pending managed selection when Disconnect occurs before the controller responds', async () => {
    const vpn = await loadVpnModule()
    vpn.waitForMobileVpnInstance()
    await vpn.suspendMobileVpnService()
    setConfig('late'); setReady('late', '10.8.0.2')
    await vpn.onNetworkInstanceChange('late', { passive: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
  })
  it('keeps a cold WebView TUN suspended while management starts and Core events arrive', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule(false)
    await vpn.initMobileManagementService()
    await vpn.prepareVpnService('A')
    await vpn.onNetworkInstanceChange('A')
    await vpn.onNetworkInstanceUpdate('A')
    await vpn.syncMobileVpnService()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(mocks.setClientEnabled).toHaveBeenCalledOnce()
    expect(mocks.setClientEnabled).toHaveBeenCalledWith(true)
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.getLocalVpnStatus).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports management foreground initialization failure without enabling the TUN', async () => {
    const vpn = await loadVpnModule(false)
    mocks.setClientEnabled.mockResolvedValueOnce({ errorMsg: 'fixture foreground failure' })
    await expect(vpn.initMobileManagementService()).rejects.toThrow('client_foreground_start_failed')
    await vpn.prepareVpnService('A')
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('adopts a committed warm TUN without restarting it and reconciles later route changes', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const snapshot = { state: 'established', running: true, established: true, requestId: 'warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: [] }
    mocks.getLocalVpnStatus.mockResolvedValue(snapshot)
    mocks.getVpnStatus.mockResolvedValue(snapshot)
    const vpn = await loadVpnModule(false)
    await vpn.resumeMobileVpnService()
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()

    mocks.networkInfo.set('A', {
      my_node_info: { virtual_ipv4: { address: { addr: '10.0.0.1' }, network_length: 24 } },
      routes: [{ proxy_cidrs: ['10.5.0.0/24'] }],
    })
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', 'warm-request')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ routes: ['10.5.0.0/24'] }))
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
  })

  it.each(['address', 'routes', 'dns'] as const)('reconciles a missed %s change once when adopting a warm TUN', async (changed) => {
    setConfig('A'); setReady('A', '10.0.0.1')
    if (changed === 'address') setReady('A', '10.0.0.9')
    if (changed === 'routes') {
      mocks.networkInfo.set('A', {
        my_node_info: { virtual_ipv4: { address: { addr: '10.0.0.1' }, network_length: 24 } },
        routes: [{ proxy_cidrs: ['10.5.0.0/24'] }],
      })
    }
    if (changed === 'dns') mocks.configs.get('A')!.enable_magic_dns = true
    const snapshot = { state: 'established', running: true, established: true, requestId: 'warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: [] }
    mocks.getLocalVpnStatus.mockResolvedValue(snapshot)
    mocks.getVpnStatus.mockResolvedValue(snapshot)
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.collectNetworkInfo).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', 'warm-request')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({
      ipv4Addr: changed === 'address' ? '10.0.0.9/24' : '10.0.0.1/24',
      routes: changed === 'routes' ? ['10.5.0.0/24'] : changed === 'dns' ? ['100.100.100.101/32'] : [],
      dns: changed === 'dns' ? '100.100.100.101' : undefined,
    }))
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.collectNetworkInfo).toHaveBeenCalledOnce()
  })

  it('keeps an unchanged warm TUN and treats routes as a set during adoption', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.configs.get('A')!.routes = ['10.5.0.0/24', '10.7.0.0/24']
    const snapshot = { state: 'established', running: true, established: true, requestId: 'warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: ['10.7.0.0/24', '10.5.0.0/24', '10.5.0.0/24'] }
    mocks.getLocalVpnStatus.mockResolvedValue(snapshot)
    mocks.getVpnStatus.mockResolvedValue(snapshot)
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.collectNetworkInfo).toHaveBeenCalledOnce()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries an unavailable config after warm adoption without losing the live owner', async () => {
    setConfig('A'); setReady('A', '10.0.0.9')
    const snapshot = { state: 'established', running: true, established: true, requestId: 'warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: [] }
    mocks.getLocalVpnStatus.mockResolvedValue(snapshot)
    mocks.getVpnStatus.mockResolvedValue(snapshot)
    mocks.getConfig.mockRejectedValueOnce(new Error('fixture unavailable RPC'))
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ ipv4Addr: '10.0.0.9/24' }))
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', 'warm-request')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not adopt a raw native VPN without a committed Core lease', async () => {
    mocks.getVpnStatus.mockResolvedValue({ state: 'established', running: true, established: true,
      requestId: 'orphan', instanceId: 'A', fd: 19 })
    const vpn = await loadVpnModule(false)
    await vpn.resumeMobileVpnService()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
  })

  it.each(['stopping', 'stopped'] as const)('recognizes a missed OS revocation before a warm %s service could be resumed', async (state) => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    mocks.getVpnStatus.mockResolvedValue({ state, running: state === 'stopping', established: false,
      requestId: 'missed-request', instanceId: 'A', stopReason: 'system_revoked' })
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(vpn.getMobileVpnError()).toBe('vpn_permission_revoked')
    await vpn.prepareVpnService('A')
    await vpn.onNetworkInstanceChange('A')
    await vpn.syncMobileVpnService()
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
  })

  it.each([
    { requestId: '', instanceId: 'A', state: 'stopped', stopReason: 'system_revoked' },
    { requestId: 'old', instanceId: '', state: 'stopped', stopReason: 'system_revoked' },
    { requestId: 'old', instanceId: 'A', state: 'established', established: true, stopReason: 'system_revoked' },
    { requestId: 'old', instanceId: 'A', state: 'starting', stopReason: 'system_revoked' },
    { requestId: 'old', instanceId: 'A', state: 'stopped' },
  ])('requires complete current native revocation evidence when no JS owner exists: %j', async (snapshot) => {
    mocks.getVpnStatus.mockResolvedValue({ running: false, ...snapshot })
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('ignores an old raw revocation snapshot after Stop and a new explicit Resume', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    let release!: (value: Record<string, unknown>) => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    mocks.getVpnStatus.mockImplementationOnce(async () => {
      entered()
      return new Promise(resolve => { release = resolve })
    })
    const observing = vpn.observeMobileVpnService()
    await waiting
    await vpn.suspendMobileVpnService()
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    release({ state: 'stopped', running: false, established: false,
      requestId: 'old-request', instanceId: 'A', stopReason: 'system_revoked' })
    expect(await observing).toBe(false)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
  })

  it('does not treat another native owner revoke reason as the selected JS owner revocation', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getVpnStatus.mockResolvedValue({ state: 'stopped', running: false, established: false,
      requestId: 'another-request', instanceId: 'B', stopReason: 'system_revoked' })
    mocks.getVpnStatus.mockClear()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(mocks.getVpnStatus).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('does not cancel an existing owner or its queued update during observation', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    let release!: (value: unknown) => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    mocks.collectNetworkInfo.mockImplementationOnce((async () => {
      entered()
      return new Promise(resolve => { release = resolve })
    }) as never)
    const update = vpn.onNetworkInstanceUpdate('A')
    await waiting
    expect(await vpn.observeMobileVpnService()).toBe(true)
    release({ info: { map: { A: {
      my_node_info: { virtual_ipv4: { address: { addr: '10.0.0.1' }, network_length: 24 } },
      routes: [{ proxy_cidrs: ['10.7.0.0/24'] }],
    } } } })
    await update
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenLastCalledWith(expect.objectContaining({ routes: ['10.7.0.0/24'] }))
  })

  it('preserves an existing owner retry timer during a read-only status observation', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    mocks.networkInfo.delete('A')
    await vpn.onNetworkInstanceUpdate('A')
    expect(vi.getTimerCount()).toBe(1)
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    setReady('A', '10.0.0.1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds retries without treating an unreadable Core configuration as a failed live VPN', async () => {
    setConfig('A')
    const snapshot = { state: 'established', running: true, established: true, requestId: 'warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: [] }
    mocks.getLocalVpnStatus.mockResolvedValue(snapshot)
    mocks.getVpnStatus.mockResolvedValue(snapshot)
    const vpn = await loadVpnModule()
    expect(await vpn.observeMobileVpnService()).toBe(true)
    for (let attempt = 0; attempt < 60; attempt++) {
      expect(await vpn.observeMobileVpnService()).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(61)
    expect(vi.getTimerCount()).toBe(0)
    expect(await vpn.observeMobileVpnService()).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(61)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    setReady('A', '10.0.0.9')
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ ipv4Addr: '10.0.0.9/24' }))
  })

  it('reports bounded connection timeout when no valid TUN could be established', async () => {
    setConfig('A')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    for (let attempt = 0; attempt < 60; attempt++) {
      expect(await vpn.observeMobileVpnService()).toBe(false)
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(vpn.getMobileVpnError()).toBe('vpn_connection_timeout')
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(61)
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(vpn.getMobileVpnError()).toBe('vpn_connection_timeout')
    await vpn.resumeMobileVpnService()
    expect(vpn.getMobileVpnError()).toBeUndefined()
    setReady('A', '10.0.0.9')
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
  })

  it('ignores a warm snapshot that finishes after an explicit VPN stop', async () => {
    const vpn = await loadVpnModule(false)
    await vpn.resumeMobileVpnService()
    let release!: (value: Record<string, unknown>) => void
    mocks.getLocalVpnStatus.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
    const observing = vpn.observeMobileVpnService()
    await vpn.suspendMobileVpnService()
    release({ state: 'established', running: true, established: true, requestId: 'old-warm-request',
      instanceId: 'A', fd: 17, ipv4Addr: '10.0.0.1/24', routes: [] })
    expect(await observing).toBe(false)
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
  })
})

describe('mobile VPN reconciliation ownership', () => {
  it('does not choose an OS VPN owner from a passive managed Core start', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { passive: true })
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    expect(mocks.getConfig).not.toHaveBeenCalled()
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the selected TUN owner and its retry timer when another Core starts in the background', async () => {
    setConfig('A'); setConfig('B')
    setReady('A', '10.0.0.1'); setReady('B', '10.0.0.2')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.networkInfo.delete('A')
    await vpn.onNetworkInstanceUpdate('A')
    mocks.getConfig.mockClear()
    await vpn.onNetworkInstanceChange('B', { passive: true })
    await vpn.onNetworkInstanceChange('', { passive: true })
    expect(mocks.getConfig).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    setReady('A', '10.0.0.1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A', 'B'] })
    await vpn.syncMobileVpnService({ preferredInstanceId: 'B', strict: true })
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'B' }))
  })

  it('still applies changed routes for the selected owner on its passive post-run notification', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    await vpn.onNetworkInstanceChange('A', { passive: true })
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'A', routes: ['10.5.0.0/24'] }))
  })

  it.each(['passive_event', 'lost_event_poll'] as const)('reattaches a replaced Core with the same UUID and routes through %s', async (trigger) => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const old = mocks.startVpn.mock.calls[0][0]
    mocks.getLocalVpnStatus.mockResolvedValue(null)
    if (trigger === 'passive_event') await vpn.onNetworkInstanceChange('A', { passive: true })
    else expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', old.requestId)
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenLastCalledWith(expect.objectContaining({ instanceId: 'A', ipv4Addr: '10.0.0.1/24', routes: [] }))
    expect(mocks.startVpn.mock.calls[1][0].requestId).not.toBe(old.requestId)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
    expect(mocks.prepareVpn).not.toHaveBeenCalled()
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    const queries = mocks.collectNetworkInfo.mock.calls.length
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(queries)
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('does not rebuild a still-proven selected Core on repeated passive notifications', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(await mocks.getVpnStatus())
    await vpn.onNetworkInstanceChange('A', { passive: true })
    await vpn.onNetworkInstanceChange('A', { passive: true })
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('keeps a single bounded Core attachment repair when native queries temporarily fail', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(null)
    mocks.getVpnStatus.mockRejectedValueOnce(new Error('fixture native query timeout'))
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    const queries = mocks.getVpnStatus.mock.calls.length
    expect(await vpn.observeMobileVpnService()).toBe(false)
    await vpn.onNetworkInstanceChange('A', { passive: true })
    expect(mocks.getVpnStatus).toHaveBeenCalledTimes(queries)
    expect(vi.getTimerCount()).toBe(1)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not lose pending Core attachment repair when a DHCP or route event cancels its timer', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockResolvedValue(null)
    mocks.getVpnStatus.mockRejectedValueOnce(new Error('fixture native query timeout'))
    expect(await vpn.observeMobileVpnService()).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a stopped selected Core without assigning its VPN to another running Core', async () => {
    setConfig('A'); setConfig('B')
    setReady('A', '10.0.0.1'); setReady('B', '10.0.0.2')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['B'] })
    mocks.getLocalVpnStatus.mockResolvedValue(null)
    await expect(vpn.observeMobileVpnService()).rejects.toThrow('vpn_no_network')
    expect(vpn.getMobileVpnError()).toBe('vpn_no_network')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('does not infer a Core replacement from a validated getter timeout', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.getLocalVpnStatus.mockRejectedValueOnce(new Error('fixture validation timeout'))
    mocks.getVpnStatus.mockClear()
    await expect(vpn.observeMobileVpnService()).rejects.toThrow('fixture validation timeout')
    expect(mocks.getVpnStatus).not.toHaveBeenCalled()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('selects an explicitly requested running network and preserves it during ordinary sync', async () => {
    setConfig('A'); setConfig('B')
    setReady('A', '10.0.0.1'); setReady('B', '10.0.0.2')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A', 'B'] })
    const vpn = await loadVpnModule()
    await vpn.syncMobileVpnService({ strict: true, preferredInstanceId: 'B' })
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'B', ipv4Addr: '10.0.0.2/24' }))
    await vpn.syncMobileVpnService({ strict: true })
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it.each(['missing', 'no_tun'] as const)('rejects an invalid preferred %s network without switching or stopping another owner', async (invalid) => {
    setConfig('A'); setConfig('B', invalid === 'no_tun')
    setReady('A', '10.0.0.1'); setReady('B', '10.0.0.2')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: invalid === 'missing' ? ['A'] : ['A', 'B'] })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    await expect(vpn.syncMobileVpnService({ strict: true, preferredInstanceId: 'B' })).rejects.toThrow('vpn_no_network')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    expect(vpn.getMobileVpnError()).toBeUndefined()
    await vpn.syncMobileVpnService({ strict: true })
    expect(mocks.startVpn).toHaveBeenCalledOnce()
  })

  it('stops A before retrying an unavailable B, then starts B when it becomes ready', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(1)

    mocks.startVpn.mockClear()
    await vpn.onNetworkInstanceChange('B')

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).not.toHaveBeenCalled()

    setReady('B', '10.0.0.2')
    await vpn.onNetworkInstanceUpdate('B')

    expect(mocks.startVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ ipv4Addr: '10.0.0.2/24', disallowedApplications: [] }))
  })

  it('stops the previous owner during pre-run even if the new instance never reaches post-run', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.stopVpn.mockClear()

    await vpn.prepareVpnService('B')

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
  })

  it('preserves the VPN while retrying the same instance', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.stopVpn.mockClear()
    mocks.networkInfo.delete('A')

    await vpn.onNetworkInstanceUpdate('A')

    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('ignores an update from an instance that no longer owns the VPN', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    await vpn.onNetworkInstanceChange('B')
    mocks.collectNetworkInfo.mockClear()

    await vpn.onNetworkInstanceUpdate('A')

    expect(mocks.collectNetworkInfo).not.toHaveBeenCalled()
  })

  it('does not apply an in-flight result after the desired instance changes', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()

    await vpn.onNetworkInstanceChange('A')
    mocks.startVpn.mockClear()
    mocks.stopVpn.mockClear()

    interface NetworkInfoResponse { info: { map: Record<string, unknown> } }
    let resolveNetworkInfo: (value: NetworkInfoResponse) => void = () => undefined
    let markCollectStarted: () => void = () => undefined
    const collectStarted = new Promise<void>((resolve) => {
      markCollectStarted = resolve
    })
    mocks.collectNetworkInfo.mockImplementationOnce(async () => await new Promise<NetworkInfoResponse>((resolve) => {
      resolveNetworkInfo = resolve
      markCollectStarted()
    }))

    const staleUpdate = vpn.onNetworkInstanceUpdate('A')
    await collectStarted
    const switchToB = vpn.onNetworkInstanceChange('B')
    resolveNetworkInfo({
      info: {
        map: {
          A: {
            my_node_info: {
              virtual_ipv4: {
                address: { addr: '10.0.0.99' },
                network_length: 24,
              },
            },
            routes: [],
          },
        },
      },
    })

    await Promise.all([staleUpdate, switchToB])

    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
  })

  it('stops a native VPN with unknown ownership before retrying the selected instance', async () => {
    setConfig('A')
    mocks.getVpnStatus.mockResolvedValue({
      running: true,
      ipv4Addr: '10.0.0.1/24',
      routes: [],
    })
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()

    await vpn.syncMobileVpnService()

    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })
})

describe('mobile VPN tile action delivery', () => {
  it('does not consume a pending action before a handler is ready', async () => {
    const vpn = await loadVpnModule()

    expect(await vpn.consumePendingMobileVpnTileAction()).toBe(false)
    expect(mocks.consumeVpnTileAction).not.toHaveBeenCalled()
  })

  it('consumes and dispatches a pending action once a handler is registered', async () => {
    const vpn = await loadVpnModule()
    const handler = vi.fn(async () => undefined)
    mocks.consumeVpnTileAction.mockResolvedValue({ action: 'start' })
    vpn.setMobileVpnTileActionHandler(handler)

    expect(await vpn.consumePendingMobileVpnTileAction()).toBe(true)
    expect(handler).toHaveBeenCalledWith('start')
  })
})

describe('Android VPN native boundaries', () => {
  it('stops reconciling immediately on an OS revocation and waits for native exit before detach', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.networkInfo.delete('A')
    await vpn.onNetworkInstanceUpdate('A')
    expect(vi.getTimerCount()).toBe(1)
    const stopping = { ...owner, stopReason: 'system_revoked', state: 'stopping', running: true, established: false }
    mocks.getVpnStatus.mockResolvedValue(stopping)
    await mocks.listeners.get('vpn_service_stop')?.(stopping)
    expect(vpn.getMobileVpnError()).toBe('vpn_permission_revoked')
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    setReady('A', '10.0.0.9')
    await vpn.onNetworkInstanceUpdate('A')
    await vpn.onNetworkInstanceChange('A')
    await vpn.syncMobileVpnService()
    expect(await vpn.observeMobileVpnService()).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.startVpn).toHaveBeenCalledOnce()

    const stopped = { ...stopping, state: 'stopped', running: false }
    mocks.getVpnStatus.mockResolvedValue(stopped)
    await mocks.listeners.get('vpn_service_stop')?.(stopped)
    await mocks.listeners.get('vpn_service_stop')?.(stopped)
    expect(mocks.clearTunFd).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', owner.requestId)
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()

    await vpn.resumeMobileVpnService()
    expect(vpn.getMobileVpnError()).toBeUndefined()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const fresh = mocks.startVpn.mock.calls[1][0]
    expect(fresh.requestId).not.toBe(owner.requestId)
    await mocks.listeners.get('vpn_service_stop')?.(stopped)
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('does not turn a failed native stop for changed routes into a successful start', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    mocks.stopVpn.mockResolvedValueOnce({ errorMsg: 'vpn_stop_failed' })
    await expect(vpn.onNetworkInstanceUpdate('A')).rejects.toThrow('vpn_stop_failed')
    expect(vpn.getMobileVpnError()).toBe('vpn_stop_failed')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
  })

  it('exposes a deterministic background failure without leaking its underlying detail', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.setTunFd.mockRejectedValueOnce(new Error('fixture private native failure'))
    await vpn.onNetworkInstanceChange('A')
    expect(vpn.getMobileVpnError()).toBe('vpn_tun_fd_failed')
    await vpn.resumeMobileVpnService()
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('clears a recovered same-instance failure only after its replacement TUN is committed', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.getLocalVpnStatus.mockImplementation(async () => mocks.getVpnStatus())
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    mocks.setTunFd.mockRejectedValueOnce(new Error('fixture transient attachment failure'))
    await vpn.onNetworkInstanceUpdate('A')
    expect(vpn.getMobileVpnError()).toBe('vpn_tun_fd_failed')

    let release!: () => void
    mocks.setTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const recovering = vpn.onNetworkInstanceUpdate('A')
    await vi.waitFor(() => expect(mocks.setTunFd).toHaveBeenCalledTimes(3))
    expect(vpn.getMobileVpnError()).toBe('vpn_tun_fd_failed')
    release()
    await recovering
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('retains a real failure when the replacement TUN is not committed', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    mocks.setTunFd.mockRejectedValueOnce(new Error('fixture first attachment failure'))
    await vpn.onNetworkInstanceUpdate('A')
    mocks.startVpn.mockResolvedValueOnce({ errorMsg: 'vpn_tun_start_failed' })
    await vpn.onNetworkInstanceUpdate('A')
    expect(vpn.getMobileVpnError()).toBe('vpn_tun_start_failed')
  })

  it('retains a stop failure until its cleanup and replacement TUN both succeed', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    mocks.stopVpn.mockResolvedValueOnce({ errorMsg: 'vpn_stop_failed' })
    await expect(vpn.onNetworkInstanceUpdate('A')).rejects.toThrow('vpn_stop_failed')

    let finishCleanup!: () => void
    mocks.clearTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { finishCleanup = resolve }))
    const recovering = vpn.onNetworkInstanceUpdate('A')
    await vi.waitFor(() => expect(mocks.clearTunFd).toHaveBeenCalledOnce())
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(vpn.getMobileVpnError()).toBe('vpn_stop_failed')
    finishCleanup()
    await recovering
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('ignores an old stop callback failure after the same-instance replacement owns the TUN', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.getLocalVpnStatus.mockImplementation(async () => mocks.getVpnStatus())
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const oldOwner = mocks.startVpn.mock.calls[0][0]
    const stopped = { ...oldOwner, state: 'stopped', running: false, established: false }
    mocks.getVpnStatus.mockResolvedValue(stopped)
    let rejectOldDetach!: (error: Error) => void
    mocks.clearTunFd.mockImplementationOnce(async () => new Promise<void>((_resolve, reject) => { rejectOldDetach = reject }))
    const oldCallback = mocks.listeners.get('vpn_service_stop')!(stopped)
    await vi.waitFor(() => expect(mocks.clearTunFd).toHaveBeenCalledOnce())

    mocks.configs.get('A')!.routes = ['10.5.0.0/24']
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    rejectOldDetach(new Error('fixture late old detach failure'))
    await oldCallback
    expect(await vpn.observeMobileVpnService()).toBe(true)
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('preserves a permission revocation when the current native cleanup fails', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    const stopped = { ...owner, state: 'stopped', running: false, established: false, stopReason: 'system_revoked' }
    mocks.getVpnStatus.mockResolvedValue(stopped)
    mocks.clearTunFd.mockRejectedValueOnce(new Error('fixture current revoked detach failure'))
    await expect(mocks.listeners.get('vpn_service_stop')!(stopped)).rejects.toThrow('vpn_stop_failed')
    expect(vpn.getMobileVpnError()).toBe('vpn_permission_revoked')
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledOnce()
  })

  it('clears the saved Core TUN owner only after native Stop is confirmed', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.clearTunFd.mockImplementationOnce(async () => {
      expect(await mocks.getVpnStatus()).toMatchObject({ state: 'stopped', running: false })
    })
    await vpn.suspendMobileVpnService()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', owner.requestId)
  })

  it('reports a failed Core detach and retains its identity for a later Stop retry', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.clearTunFd.mockRejectedValueOnce(new Error('fixture detach failed'))

    await expect(vpn.suspendMobileVpnService()).rejects.toThrow('vpn_stop_failed')
    await vpn.suspendMobileVpnService()
    expect(mocks.clearTunFd).toHaveBeenNthCalledWith(1, 'A', owner.requestId)
    expect(mocks.clearTunFd).toHaveBeenNthCalledWith(2, 'A', owner.requestId)
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('does not hide a Core detach failure while cleaning up an unsuccessful start', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.setTunFd.mockRejectedValueOnce(new Error('fixture attachment failed'))
    mocks.clearTunFd.mockRejectedValueOnce(new Error('fixture detach failed'))
    const vpn = await loadVpnModule()
    await expect(vpn.onNetworkInstanceChange('A', { strict: true })).rejects.toThrow('vpn_stop_failed')
    const owner = mocks.startVpn.mock.calls[0][0]
    await vpn.suspendMobileVpnService()
    expect(mocks.clearTunFd).toHaveBeenLastCalledWith('A', owner.requestId)
  })

  it('reports a matching native Stop detach failure instead of clearing its JS owner', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.getVpnStatus.mockResolvedValue({ ...owner, state: 'stopped', running: false })
    mocks.clearTunFd.mockRejectedValueOnce(new Error('fixture detach failed'))
    await expect(mocks.listeners.get('vpn_service_stop')?.(owner)).rejects.toThrow('vpn_stop_failed')
    expect(vpn.getMobileVpnError()).toBe('vpn_stop_failed')
    await mocks.listeners.get('vpn_service_stop')?.(owner)
    expect(mocks.clearTunFd).toHaveBeenCalledTimes(2)
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('does not let a delayed Stop detach completion overwrite a resumed owner', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const old = mocks.startVpn.mock.calls[0][0]
    let release!: () => void
    mocks.getVpnStatus.mockResolvedValue({ ...old, state: 'stopped', running: false })
    mocks.clearTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const oldStop = mocks.listeners.get('vpn_service_stop')?.(old)
    await vi.waitFor(() => expect(mocks.clearTunFd).toHaveBeenCalledOnce())
    await vpn.suspendMobileVpnService()
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    release()
    await oldStop
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
    expect(mocks.clearTunFd.mock.calls.every(([, requestId]) => requestId === old.requestId)).toBe(true)
  })

  it('coalesces same-instance route updates while a strict native start establishes', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let requested!: Record<string, unknown>
    mocks.startVpn.mockImplementationOnce(async request => {
      requested = request
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true, established: false })
      return {}
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.startVpn).toHaveBeenCalledOnce())

    const updates = []
    for (let index = 0; index < 10; index++) {
      mocks.configs.get('A')!.routes = [`10.${index}.0.0/16`]
      updates.push(vpn.onNetworkInstanceUpdate('A'))
    }
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    await nativeEstablished(requested, 7, false)
    await vi.advanceTimersByTimeAsync(100)

    await Promise.all(updates)
    expect(await starting).toBeNull()
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenLastCalledWith(expect.objectContaining({ routes: ['10.9.0.0/16'] }))
    expect(mocks.setTunFd).toHaveBeenNthCalledWith(1, 7, 'A', requested.requestId)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an in-flight TUN attachment valid across redundant same-instance updates', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let release!: () => void
    mocks.setTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.setTunFd).toHaveBeenCalledOnce())
    const updates = Array.from({ length: 10 }, () => vpn.onNetworkInstanceUpdate('A'))
    release()

    await Promise.all(updates)
    expect(await starting).toBeNull()
    expect(mocks.collectNetworkInfo).toHaveBeenCalledTimes(2)
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('discards updates accumulated by a failed strict start but allows a later retry', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let rejectAttach!: (error: Error) => void
    mocks.setTunFd.mockImplementationOnce(async () => new Promise<void>((_resolve, reject) => { rejectAttach = reject }))
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.setTunFd).toHaveBeenCalledOnce())
    const updates = Array.from({ length: 5 }, () => vpn.onNetworkInstanceUpdate('A'))
    rejectAttach(new Error('fixture failed attachment'))

    await Promise.all(updates)
    expect(await starting).toMatchObject({ message: 'vpn_tun_fd_failed' })
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
  })

  it('still cancels an establishing owner when another instance replaces queued updates', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    setConfig('B'); setReady('B', '10.0.0.2')
    let requested!: Record<string, unknown>
    mocks.startVpn.mockImplementationOnce(async request => {
      requested = request
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true, established: false })
      return {}
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.startVpn).toHaveBeenCalledOnce())
    const update = vpn.onNetworkInstanceUpdate('A')
    const replacing = vpn.onNetworkInstanceChange('B', { strict: true })
    await nativeEstablished(requested, 7, false)
    await vi.advanceTimersByTimeAsync(100)

    await Promise.all([update, replacing])
    expect(await starting).toMatchObject({ message: 'vpn_request_canceled' })
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.setTunFd).toHaveBeenCalledWith(1, 'B', expect.any(String))
  })

  it('cancels both an establishing owner and its queued updates on explicit Stop', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let requested!: Record<string, unknown>
    mocks.startVpn.mockImplementationOnce(async request => {
      requested = request
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true, established: false })
      return {}
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => null, error => error)
    await vi.waitFor(() => expect(mocks.startVpn).toHaveBeenCalledOnce())
    const updates = Array.from({ length: 5 }, () => vpn.onNetworkInstanceUpdate('A'))
    const stopping = vpn.suspendMobileVpnService()
    await nativeEstablished(requested, 7, false)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([...updates, stopping])

    expect(await starting).toMatchObject({ message: 'vpn_request_canceled' })
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('suspends the VPN and ignores delayed instance updates until explicit resume', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    await vpn.suspendMobileVpnService()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
    await vpn.onNetworkInstanceChange('A')
    await vpn.onNetworkInstanceUpdate('A')
    await vpn.syncMobileVpnService()
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vpn.resumeMobileVpnService()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('verifies a stopped native VPN even when its stop event was lost', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    mocks.stopVpn.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockResolvedValue({ running: false, state: 'stopped' })
      return {}
    })
    await vpn.suspendMobileVpnService()
    expect(mocks.getVpnStatus).toHaveBeenCalled()
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('does not claim a successful stop while the native service remains active', async () => {
    const vpn = await loadVpnModule()
    mocks.stopVpn.mockImplementationOnce(async () => ({}))
    mocks.getVpnStatus.mockResolvedValue({ running: true })
    const stopped = expect(vpn.suspendMobileVpnService()).rejects.toThrow('vpn_stop_timeout')
    await vi.advanceTimersByTimeAsync(15100)
    await stopped
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('bounds a hung stop status query and retains the Core lease for Retry Disconnect', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.stopVpn.mockResolvedValueOnce({})
    mocks.getVpnStatus.mockImplementation(() => new Promise(() => {}))
    const stopping = expect(vpn.suspendMobileVpnService()).rejects.toThrow('vpn_stop_timeout')
    await vi.advanceTimersByTimeAsync(15100)
    await stopping
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    mocks.getVpnStatus.mockResolvedValue({ state: 'stopped', running: false })
    await vpn.suspendMobileVpnService()
    expect(mocks.clearTunFd).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', owner.requestId)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates an explicit native stop failure while preventing automatic restart', async () => {
    const vpn = await loadVpnModule()
    mocks.stopVpn.mockResolvedValueOnce({ errorMsg: 'fixture service failure' })
    await expect(vpn.suspendMobileVpnService()).rejects.toThrow('vpn_stop_failed')
    setConfig('A')
    setReady('A', '10.0.0.1')
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('stops the OS VPN without changing management foreground intent', async () => {
    const vpn = await loadVpnModule()
    await vpn.initMobileManagementService()
    expect(mocks.setClientEnabled).toHaveBeenCalledWith(true)
    mocks.setClientEnabled.mockClear()
    await vpn.suspendMobileVpnService()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    await vpn.resumeMobileVpnService()
    expect(mocks.setClientEnabled).not.toHaveBeenCalled()
  })

  it('closes a late native start without attaching its descriptor after suspension', async () => {
    const vpn = await loadVpnModule()
    await vpn.suspendMobileVpnService()
    await mocks.listeners.get('vpn_service_start')?.({ fd: 8 })
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledTimes(1)
  })

  it('rejects the Core sentinel descriptor zero without claiming the TUN is attached', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.startVpn.mockImplementationOnce(async request => { await nativeEstablished(request, 0); return {} })
    const vpn = await loadVpnModule()
    await expect(vpn.onNetworkInstanceChange('A', { strict: true })).rejects.toThrow('vpn_tun_fd_failed')
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
  })

  it('cleans native VPN when installing its TUN descriptor in Core fails', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.setTunFd.mockRejectedValueOnce(new Error('fixture fd failure'))
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['Core TUN installation timed out', 'vpn_core_install_timeout'],
    ['VPN status query timed out', 'vpn_core_status_timeout'],
    ['TUN descriptor is no longer available', 'vpn_tun_descriptor_unavailable'],
    ['TUN Core instance was replaced', 'vpn_core_instance_replaced'],
  ])('retains a safe diagnostic for %s through failed-start cleanup and clears it after recovery', async (message, diagnostic) => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.setTunFd.mockRejectedValueOnce(message)
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(vpn.getMobileVpnError()).toBe('vpn_tun_fd_failed')
    const failureCode = () => (vpn as typeof vpn & { getMobileVpnFailureCode?: () => string | undefined })
      .getMobileVpnFailureCode?.() ?? vpn.getMobileVpnError()
    expect(failureCode()).toBe(diagnostic)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(failureCode()).toBeUndefined()
  })

  it('does not expose arbitrary bridge rejection text as a diagnostic', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.setTunFd.mockRejectedValueOnce(new Error('udp://private.invalid:22020/SECRET_MUST_NOT_ESCAPE'))
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    const failureCode = (vpn as typeof vpn & { getMobileVpnFailureCode?: () => string | undefined })
      .getMobileVpnFailureCode?.() ?? vpn.getMobileVpnError()
    expect(failureCode).toBe('vpn_tun_fd_failed')
  })

  it.each(['before Core attachment', 'after Core attachment'])('rechecks a transient native status rejection %s without discarding a healthy TUN', async phase => {
    setConfig('A'); setReady('A', '10.0.0.1')
    if (phase === 'before Core attachment') {
      mocks.startVpn.mockImplementationOnce(async request => {
        await nativeEstablished(request)
        mocks.getVpnStatus.mockRejectedValueOnce(new Error('temporary status query unavailable'))
        return {}
      })
    } else {
      mocks.setTunFd.mockImplementationOnce(async () => {
        mocks.getVpnStatus.mockRejectedValueOnce(new Error('temporary status query unavailable'))
      })
    }
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => undefined, error => error.message)
    await vi.advanceTimersByTimeAsync(200)
    expect(await starting).toBeUndefined()
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    expect(vpn.getMobileVpnError()).toBeUndefined()
  })

  it('bounds a hung native confirmation without claiming a connected VPN or reattaching Core', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.setTunFd.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockImplementationOnce(() => new Promise(() => {}))
    })
    const vpn = await loadVpnModule()
    let outcome: string | undefined
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(
      () => { outcome = 'connected' }, error => { outcome = error.message },
    )
    await vi.advanceTimersByTimeAsync(14900)
    expect(outcome).toBeUndefined()
    expect(mocks.stopVpn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(outcome).toBe('vpn_start_timeout')
    await starting
    expect(vpn.getMobileVpnFailureCode()).toBe('vpn_native_confirmation_timeout')
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a hung native query at the explicit sync entry before starting a VPN', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    mocks.getVpnStatus.mockImplementation(() => new Promise(() => {}))
    let outcome: string | undefined
    const syncing = vpn.syncMobileVpnService({ strict: true, preferredInstanceId: 'A' }).then(
      () => { outcome = 'connected' }, error => { outcome = error.message },
    )
    await vi.advanceTimersByTimeAsync(14900)
    expect(outcome).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(outcome).toBe('vpn_start_timeout')
    await syncing
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['preflight', 'start_status', 'confirmation'] as const)('distinguishes rejected IPC from a missing reply during %s without exposing native text', async phase => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    const rejectStatus = () => mocks.getVpnStatus.mockRejectedValue({
      code: 'COMMAND_FAILED', message: 'udp://private.invalid:22020/SECRET_MUST_NOT_ESCAPE',
    })
    if (phase === 'preflight') rejectStatus()
    else if (phase === 'start_status') mocks.startVpn.mockImplementationOnce(async request => {
      await nativeEstablished(request)
      rejectStatus()
      return {}
    })
    else mocks.setTunFd.mockImplementationOnce(async () => { rejectStatus() })
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(18100)
    const error = await starting
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(phase === 'preflight' ? 'vpn_start_failed' : 'vpn_start_timeout')
    expect(vpn.getMobileVpnFailureCode(error)).toBe(`vpn_native_${phase}_rejected`)
    expect(vpn.getMobileVpnFailureCode()).toBe(`vpn_native_${phase}_rejected`)
    expect(JSON.stringify(error)).not.toMatch(/private\.invalid|SECRET_MUST_NOT_ESCAPE/)
    expect(mocks.startVpn).toHaveBeenCalledTimes(phase === 'preflight' ? 0 : 1)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(phase === 'confirmation' ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['preflight', 'start_status'] as const)('identifies a missing %s reply before Core attachment', async phase => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    if (phase === 'preflight') mocks.getVpnStatus.mockImplementation(() => new Promise(() => {}))
    else mocks.startVpn.mockImplementationOnce(async request => {
      await nativeEstablished(request)
      mocks.getVpnStatus.mockImplementation(() => new Promise(() => {}))
      return {}
    })
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(18100)
    const error = await starting
    expect(error.message).toBe('vpn_start_timeout')
    expect(vpn.getMobileVpnFailureCode(error)).toBe(`vpn_native_${phase}_timeout`)
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a preflight IPC diagnostic when sync fails before selecting a JS owner', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    const vpn = await loadVpnModule()
    mocks.getVpnStatus.mockRejectedValue({ code: 'NO_PLUGIN', message: 'private native text' })
    const error = await vpn.syncMobileVpnService({ strict: true, preferredInstanceId: 'A' }).catch(error => error)
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(vpn.getMobileVpnFailureCode(error)).toBe('vpn_native_preflight_rejected')
    expect(mocks.startVpn).not.toHaveBeenCalled()
    expect(mocks.setTunFd).not.toHaveBeenCalled()
  })

  it('reports a later hung confirmation instead of an earlier transient rejection', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    mocks.setTunFd.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockRejectedValueOnce('temporary rejection')
        .mockImplementationOnce(() => new Promise(() => {}))
    })
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).catch(error => error)
    await vi.advanceTimersByTimeAsync(18100)
    const error = await starting
    expect(vpn.getMobileVpnFailureCode(error)).toBe('vpn_native_confirmation_timeout')
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disconnects during a hung confirmation and ignores its late snapshot after reconnecting', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let release!: (snapshot: Record<string, unknown>) => void
    mocks.setTunFd.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true }).then(() => '', error => error.message)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.setTunFd).toHaveBeenCalledOnce()
    const old = mocks.startVpn.mock.calls[0][0]
    let stopped = false
    const stopping = vpn.suspendMobileVpnService().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(stopped).toBe(true)
    await stopping
    expect(await starting).toBe('vpn_request_canceled')
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', old.requestId)
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const current = mocks.startVpn.mock.calls[1][0]
    release({ ...old, state: 'established', running: true, established: true, fd: 1 })
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
    expect(mocks.setTunFd).toHaveBeenLastCalledWith(1, 'A', current.requestId)
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vpn.getMobileVpnError()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a hung owner repair query so Disconnect can stop and detach the VPN', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const owner = mocks.startVpn.mock.calls[0][0]
    mocks.getLocalVpnStatus.mockResolvedValue(null)
    const reads = mocks.getVpnStatus.mock.calls.length
    mocks.getVpnStatus.mockImplementationOnce(() => new Promise(() => {}))
    const observing = vpn.observeMobileVpnService()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getVpnStatus.mock.calls.length).toBeGreaterThan(reads)
    let stopped = false
    const stopping = vpn.suspendMobileVpnService().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(stopped).toBe(true)
    await Promise.all([observing, stopping])
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', owner.requestId)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the previous VPN alive when permission for another network is denied', async () => {
    setConfig('A')
    setConfig('B')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    mocks.prepareVpn.mockResolvedValueOnce({ granted: false })
    await expect(vpn.prepareVpnService('B')).rejects.toThrow('vpn_permission_denied')
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('ignores a late network-info response after a quick stop', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    let release!: (result: unknown) => void
    let begun!: () => void
    const started = new Promise<void>(resolve => { begun = resolve })
    mocks.collectNetworkInfo.mockImplementationOnce((async () => { begun(); return new Promise(resolve => { release = resolve }) }) as never)
    const starting = vpn.onNetworkInstanceChange('A')
    await started
    const stopping = vpn.onNetworkInstanceChange('')
    release({ info: { map: { A: mocks.networkInfo.get('A') } } })
    await Promise.all([starting, stopping])
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('unregisters native listeners and cancels delayed reconciliation on disposal', async () => {
    setConfig('A')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(vi.getTimerCount()).toBe(1)
    vpn.disposeMobileVpnService()
    expect(mocks.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('does not start a new native VPN after stop cancels a pending permission request', async () => {
    setConfig('A')
    let grant!: (permission: { granted: boolean }) => void
    mocks.prepareVpn.mockImplementationOnce(async () => new Promise(resolve => { grant = resolve }))
    const vpn = await loadVpnModule()
    const preparing = vpn.prepareVpnService('A')
    await vi.waitFor(() => expect(mocks.prepareVpn).toHaveBeenCalledOnce())
    await vpn.onNetworkInstanceChange('')
    grant({ granted: true })
    await expect(preparing).rejects.toThrow('vpn_request_canceled')
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('cleans a partial foreground VPN when the start invoke fails', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.startVpn.mockImplementationOnce(async request => {
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true })
      throw new Error('fixture partial native start')
    })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
  })

  it('cleans a foreground VPN when native never establishes its descriptor', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    let begun!: () => void
    const started = new Promise<void>(resolve => { begun = resolve })
    mocks.startVpn.mockImplementationOnce(async request => {
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true, established: false })
      begun()
      return {}
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A')
    await started
    await vi.advanceTimersByTimeAsync(15100)
    await starting
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
  })

  it('attaches a confirmed native descriptor even if the start event is lost', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.startVpn.mockImplementationOnce(async request => { await nativeEstablished(request, 9, false); return {} })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    expect(mocks.setTunFd).toHaveBeenCalledWith(9, 'A', expect.any(String))
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('ignores an old start callback after Stop and a new Resume', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const old = mocks.startVpn.mock.calls[0][0]
    await vpn.suspendMobileVpnService()
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    const fresh = mocks.startVpn.mock.calls[1][0]
    expect(fresh.requestId).not.toBe(old.requestId)
    mocks.setTunFd.mockClear()
    mocks.clearTunFd.mockClear()
    await mocks.listeners.get('vpn_service_start')?.({ ...old, fd: 99 })
    await mocks.listeners.get('vpn_service_stop')?.(old)
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.clearTunFd).not.toHaveBeenCalled()
    await vpn.onNetworkInstanceUpdate('A')
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
  })

  it('does not publish a TUN attachment that finishes after Stop invalidates its request', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let release!: () => void
    mocks.setTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const vpn = await loadVpnModule()
    const starting = expect(vpn.onNetworkInstanceChange('A', { strict: true })).rejects.toThrow('vpn_request_canceled')
    await vi.waitFor(() => expect(mocks.setTunFd).toHaveBeenCalledOnce())
    const stopping = vpn.suspendMobileVpnService()
    release()
    await starting
    await stopping
    const old = mocks.startVpn.mock.calls[0][0]
    expect(mocks.clearTunFd).toHaveBeenCalledWith('A', old.requestId)
    await vpn.resumeMobileVpnService()
    await vpn.onNetworkInstanceChange('A', { strict: true })
    expect(mocks.startVpn).toHaveBeenCalledTimes(2)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(2)
  })

  it('rejects an attachment if its fresh native snapshot belongs to another request', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let release!: () => void
    mocks.setTunFd.mockImplementationOnce(async () => new Promise<void>(resolve => { release = resolve }))
    const vpn = await loadVpnModule()
    const starting = expect(vpn.onNetworkInstanceChange('A', { strict: true })).rejects.toThrow('vpn_request_canceled')
    await vi.waitFor(() => expect(mocks.setTunFd).toHaveBeenCalledOnce())
    mocks.getVpnStatus.mockResolvedValue({ state: 'established', running: true, established: true, requestId: 'new-native-owner', instanceId: 'B', fd: 11 })
    release()
    await starting
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('survives a delayed native establishment beyond the old three-second event deadline', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    let requested!: Record<string, unknown>
    mocks.startVpn.mockImplementationOnce(async request => {
      requested = request
      mocks.getVpnStatus.mockResolvedValue({ ...request, state: 'starting', running: true, established: false })
      return {}
    })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A', { strict: true })
    await vi.waitFor(() => expect(mocks.startVpn).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(4000)
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    await nativeEstablished(requested, 7, false)
    await vi.advanceTimersByTimeAsync(100)
    await starting
    expect(mocks.setTunFd).toHaveBeenCalledWith(7, 'A', requested.requestId)
    expect(mocks.stopVpn).not.toHaveBeenCalled()
  })

  it('does not acknowledge Stop while native reports STOPPING even if running is false', async () => {
    const vpn = await loadVpnModule()
    mocks.stopVpn.mockImplementationOnce(async () => {
      mocks.getVpnStatus.mockResolvedValue({ running: false, state: 'stopping' })
      return {}
    })
    let finished = false
    const stopping = vpn.suspendMobileVpnService().then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(500)
    expect(finished).toBe(false)
    mocks.getVpnStatus.mockResolvedValue({ running: false, state: 'stopped' })
    await vi.advanceTimersByTimeAsync(100)
    await stopping
    expect(finished).toBe(true)
  })

  it('propagates a native foreground startup failure during explicit strict synchronization', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: ['A'] })
    mocks.startVpn.mockImplementationOnce(async () => ({ errorMsg: 'vpn_foreground_start_failed' }))
    const vpn = await loadVpnModule()
    await expect(vpn.syncMobileVpnService({ strict: true })).rejects.toThrow('vpn_foreground_start_failed')
    expect(mocks.setTunFd).not.toHaveBeenCalled()
  })

  it('uses a new native request for every repeated resume without leaving transition timers', async () => {
    setConfig('A'); setReady('A', '10.0.0.1')
    const vpn = await loadVpnModule()
    for (let index = 0; index < 10; index++) {
      await vpn.onNetworkInstanceChange('A', { strict: true })
      await vpn.suspendMobileVpnService()
      await vpn.resumeMobileVpnService()
    }
    expect(new Set(mocks.startVpn.mock.calls.map(([request]) => request.requestId)).size).toBe(10)
    expect(mocks.setTunFd).toHaveBeenCalledTimes(10)
    expect(vi.getTimerCount()).toBe(0)
  })
})
