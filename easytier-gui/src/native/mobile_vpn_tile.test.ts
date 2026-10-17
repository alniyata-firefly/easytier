import type * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import type * as NetworkTypes from '../../../easytier-web/frontend-lib/src/types/network'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeVpnTileAction } from './mobile_vpn_tile'

vi.mock('../../../easytier-web/frontend-lib/src/modules/utils', () => ({
    UuidToStr: (value: unknown) => String(value),
}))

function createApi(runningIds: string[], disabledIds: string[], noTunIds: string[] = [], managedIds: string[] = []) {
  const configs = new Map(
    [...new Set([...runningIds, ...disabledIds])].map(instanceId => [
      instanceId,
      { instance_id: instanceId, no_tun: noTunIds.includes(instanceId) } as unknown as NetworkTypes.NetworkConfig,
    ]),
  )
  return {
    api: {
      list_network_instance_ids: vi.fn(async () => ({
        running_inst_ids: runningIds,
        disabled_inst_ids: disabledIds,
      })),
      get_network_config: vi.fn(async (instanceId: string) => configs.get(instanceId)!),
      get_network_metas: vi.fn(async (ids: string[]) => ({ metas: Object.fromEntries(ids.map(id => [id, { network_name: id, config_permission: 0, source: managedIds.includes(id) ? 2 : 1 }])) })),
      run_network: vi.fn(async () => undefined),
      update_network_instance_state: vi.fn(async () => undefined),
    } as unknown as Api.RemoteClient,
    configs,
  }
}

describe('vpn quick settings tile actions', () => {
  const syncVpnService = vi.fn(async () => undefined)

  beforeEach(() => {
    syncVpnService.mockClear()
  })

  it('starts the last configured network and reconciles the Android VPN', async () => {
    const { api } = createApi([], ['first', 'last'])

    const result = await executeVpnTileAction('start', api, {
      lastInstanceId: 'last',
      syncVpnService,
    })

    expect(api.update_network_instance_state).toHaveBeenCalledWith('last', false)
    expect(syncVpnService).toHaveBeenCalledOnce()
    expect(syncVpnService).toHaveBeenCalledWith('last')
    expect(result).toEqual({ action: 'start', instanceId: 'last', changed: true })
  })

  it('waits for the controller instead of starting a cached managed configuration', async () => {
    const { api } = createApi([], ['managed'], [], ['managed'])
    expect(await executeVpnTileAction('start', api, { lastInstanceId: 'managed', syncVpnService }))
      .toEqual({ action: 'start', changed: false })
    expect(api.update_network_instance_state).not.toHaveBeenCalled()
    expect(api.run_network).not.toHaveBeenCalled()
    expect(syncVpnService).not.toHaveBeenCalled()
  })

  it('does not let a cached removed membership hide a fresh running managed network', async () => {
    const { api } = createApi(['fresh'], ['removed'], [], ['fresh', 'removed'])
    expect(await executeVpnTileAction('start', api, { lastInstanceId: 'removed', syncVpnService }))
      .toEqual({ action: 'start', instanceId: 'fresh', changed: false })
    expect(syncVpnService).toHaveBeenCalledWith('fresh')
    expect(api.update_network_instance_state).not.toHaveBeenCalled()
  })

  it('can attach a managed instance already running but cannot stop it locally', async () => {
    const { api } = createApi(['managed'], [], [], ['managed'])
    await executeVpnTileAction('start', api, { syncVpnService })
    expect(syncVpnService).toHaveBeenCalledWith('managed')
    await expect(executeVpnTileAction('stop', api, { syncVpnService })).rejects.toThrow('managed_lifecycle_owned_by_controller')
    expect(api.update_network_instance_state).not.toHaveBeenCalled()
  })

  it('skips a no_tun last network and starts the first TUN-capable network', async () => {
    const { api } = createApi([], ['first', 'last'], ['last'])

    const result = await executeVpnTileAction('start', api, {
      lastInstanceId: 'last',
      syncVpnService,
    })

    expect(api.update_network_instance_state).toHaveBeenCalledWith('first', false)
    expect(syncVpnService).toHaveBeenCalledOnce()
    expect(syncVpnService).toHaveBeenCalledWith('first')
    expect(result).toEqual({ action: 'start', instanceId: 'first', changed: true })
  })

  it('does nothing when only no_tun networks are configured', async () => {
    const { api } = createApi([], ['headless'], ['headless'])

    const result = await executeVpnTileAction('start', api, {
      lastInstanceId: 'headless',
      syncVpnService,
    })

    expect(api.run_network).not.toHaveBeenCalled()
    expect(syncVpnService).not.toHaveBeenCalled()
    expect(result).toEqual({ action: 'start', changed: false })
  })

  it('does not restart an already running network', async () => {
    const { api } = createApi(['running'], [])

    const result = await executeVpnTileAction('start', api, {
      lastInstanceId: 'running',
      syncVpnService,
    })

    expect(api.run_network).not.toHaveBeenCalled()
    expect(syncVpnService).toHaveBeenCalledOnce()
    expect(syncVpnService).toHaveBeenCalledWith('running')
    expect(result.changed).toBe(false)
  })

  it('passes the selected running instance instead of relying on running list order', async () => {
    const { api } = createApi(['first', 'selected'], [])
    const result = await executeVpnTileAction('start', api, {
      lastInstanceId: 'selected',
      syncVpnService,
    })
    expect(api.update_network_instance_state).not.toHaveBeenCalled()
    expect(syncVpnService).toHaveBeenCalledWith('selected')
    expect(result).toEqual({ action: 'start', instanceId: 'selected', changed: false })
  })

  it('stops the last running network, falling back to the first running network', async () => {
    const { api } = createApi(['first', 'second'], ['disabled'])

    const result = await executeVpnTileAction('stop', api, {
      lastInstanceId: 'disabled',
      syncVpnService,
    })

    expect(api.update_network_instance_state).toHaveBeenCalledWith('first', true)
    expect(syncVpnService).toHaveBeenCalledOnce()
    expect(syncVpnService).toHaveBeenCalledWith(undefined)
    expect(result).toEqual({ action: 'stop', instanceId: 'first', changed: true })
  })

  it('does not select a running no_tun network for stop', async () => {
    const { api } = createApi(['headless', 'vpn'], [], ['headless'])

    const result = await executeVpnTileAction('stop', api, {
      lastInstanceId: 'headless',
      syncVpnService,
    })

    expect(api.update_network_instance_state).toHaveBeenCalledWith('vpn', true)
    expect(syncVpnService).toHaveBeenCalledOnce()
    expect(syncVpnService).toHaveBeenCalledWith(undefined)
    expect(result).toEqual({ action: 'stop', instanceId: 'vpn', changed: true })
  })

  it('reports that no action is possible when no matching network exists', async () => {
    const { api } = createApi([], ['configured'])

    const result = await executeVpnTileAction('stop', api, {
      syncVpnService,
    })

    expect(api.update_network_instance_state).not.toHaveBeenCalled()
    expect(syncVpnService).not.toHaveBeenCalled()
    expect(result).toEqual({ action: 'stop', changed: false })
  })
})
