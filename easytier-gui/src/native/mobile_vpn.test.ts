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

async function loadVpnModule() {
  const mobileVpn = await import('./mobile_vpn')
  await mobileVpn.initMobileVpnService()
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
    expect(mocks.setClientEnabled).toHaveBeenCalledWith(false)
    await vpn.onNetworkInstanceChange('A')
    await vpn.onNetworkInstanceUpdate('A')
    await vpn.syncMobileVpnService()
    expect(mocks.startVpn).toHaveBeenCalledOnce()
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vpn.resumeMobileVpnService()
    expect(mocks.setClientEnabled).toHaveBeenLastCalledWith(true)
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

  it('propagates an explicit native stop failure while preventing automatic restart', async () => {
    const vpn = await loadVpnModule()
    mocks.stopVpn.mockResolvedValueOnce({ errorMsg: 'fixture service failure' })
    await expect(vpn.suspendMobileVpnService()).rejects.toThrow('vpn_stop_failed')
    setConfig('A')
    setReady('A', '10.0.0.1')
    await vpn.onNetworkInstanceChange('A')
    expect(mocks.startVpn).not.toHaveBeenCalled()
  })

  it('still closes the VPN and reports a failure when the keepalive service cannot stop', async () => {
    const vpn = await loadVpnModule()
    mocks.setClientEnabled.mockResolvedValueOnce({ errorMsg: 'fixture foreground failure' })
    await expect(vpn.suspendMobileVpnService()).rejects.toThrow('client_foreground_stop_failed')
    expect(mocks.stopVpn).toHaveBeenCalledOnce()
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
