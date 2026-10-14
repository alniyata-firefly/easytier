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
    getVpnStatus: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ running: false })),
    listNetworkInstanceIds: vi.fn<() => Promise<{ running_inst_ids: unknown[] }>>(async () => ({ running_inst_ids: [] })),
    prepareVpn: vi.fn(async () => ({ granted: true })),
    setTunFd: vi.fn(async () => undefined),
    startVpn: vi.fn(async () => {
      await listeners.get('vpn_service_start')?.({ fd: 1 })
      return {}
    }),
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
}))

vi.mock('./backend', () => ({
  collectNetworkInfo: mocks.collectNetworkInfo,
  getConfig: mocks.getConfig,
  listNetworkInstanceIds: mocks.listNetworkInstanceIds,
  setTunFd: mocks.setTunFd,
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

async function loadVpnModule() {
  const mobileVpn = await import('./mobile_vpn')
  await mobileVpn.initMobileVpnService()
  return mobileVpn
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
  mocks.getVpnStatus.mockReset()
  mocks.getVpnStatus.mockResolvedValue({ running: false })
  mocks.listNetworkInstanceIds.mockReset()
  mocks.listNetworkInstanceIds.mockResolvedValue({ running_inst_ids: [] })
  mocks.prepareVpn.mockReset()
  mocks.prepareVpn.mockResolvedValue({ granted: true })
  mocks.setTunFd.mockReset()
  mocks.setTunFd.mockResolvedValue(undefined)
  mocks.setTunFd.mockClear()
  mocks.startVpn.mockClear()
  mocks.stopVpn.mockClear()
})

describe('mobile VPN reconciliation ownership', () => {
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
    expect(mocks.startVpn).toHaveBeenCalledWith(expect.objectContaining({ ipv4Addr: '10.0.0.2/24' }))
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
  it('passes file descriptor zero into Core', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    mocks.startVpn.mockImplementationOnce(async () => { await mocks.listeners.get('vpn_service_start')?.({ fd: 0 }); return {} })
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.setTunFd).toHaveBeenCalledWith(0)
    expect(mocks.stopVpn).not.toHaveBeenCalled()
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
    mocks.startVpn.mockRejectedValueOnce(new Error('fixture partial native start'))
    const vpn = await loadVpnModule()
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
  })

  it('cleans a foreground VPN when the TUN descriptor event never arrives', async () => {
    setConfig('A')
    setReady('A', '10.0.0.1')
    let begun!: () => void
    const started = new Promise<void>(resolve => { begun = resolve })
    mocks.startVpn.mockImplementationOnce(async () => { begun(); return {} })
    const vpn = await loadVpnModule()
    const starting = vpn.onNetworkInstanceChange('A')
    await started
    await vi.advanceTimersByTimeAsync(3100)
    await starting
    expect(mocks.setTunFd).not.toHaveBeenCalled()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
  })
})
