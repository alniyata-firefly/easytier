import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import { UuidToStr } from '../../../easytier-web/frontend-lib/src/modules/utils'
import { loadEnabledNetworks, loadStoredConfigs, saveEnabledNetworks, saveStoredConfigs } from './storage'
import { GUIRemoteClient } from './client'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), prepareVpnService: vi.fn(), changed: vi.fn(), offline: true }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'android' }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('./mobile_vpn', () => ({ prepareVpnService: mock.prepareVpnService, syncMobileVpnService: vi.fn(async () => undefined) }))
const userId = '11111111-1111-4111-8111-111111111111', managedId = '22222222-2222-4222-8222-222222222222'
const store = new Map<string, string>()
const config = (id = userId) => ({ ...Network.DEFAULT_NETWORK_CONFIG(), instance_id: id, network_name: 'Offline fixture', future_option: { retain: true } })
const createClient = () => new GUIRemoteClient({ offline: () => mock.offline, changed: mock.changed })
beforeEach(() => {
  vi.clearAllMocks()
  mock.offline = true
  mock.invoke.mockImplementation(async command => {
    if (command === 'parse_network_config') return 'network_name = "Offline fixture"'
    throw new Error('runtime unavailable')
  })
  store.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } })
})
describe('offline local network configuration management', () => {
  it('refuses data-plane starts while Android is globally paused even with RPC and management online', async () => {
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, runtimeAllowed: () => false })
    await expect(client.run_network(config(), true)).rejects.toThrow('client_not_running')
    await expect(client.update_network_instance_state(userId, false)).rejects.toThrow('client_not_running')
    expect(mock.invoke).not.toHaveBeenCalled()
    expect(mock.prepareVpnService).not.toHaveBeenCalled()
  })

  it('rejects local lifecycle changes for an explicitly managed source without confusing file permissions', async () => {
    mock.invoke.mockImplementation(async command => {
      if (command === 'get_network_metas') return { metas: { [managedId]: { network_name: 'Managed', config_permission: 0, source: 'ConfigSourceWeb' } } }
      throw new Error('unexpected mutation')
    })
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed })
    await expect(client.update_network_instance_state(managedId, true)).rejects.toThrow('managed_lifecycle_owned_by_controller')
    await expect(client.update_network_instance_state(managedId, false)).rejects.toThrow('managed_lifecycle_owned_by_controller')
    expect(mock.invoke.mock.calls.every(([command]) => command === 'get_network_metas')).toBe(true)
    expect(mock.prepareVpnService).not.toHaveBeenCalled()
  })

  it('saves to the real remote persistence API and reads durable desired configuration after reconnecting', async () => {
    const live = { ...config(), mtu: 1280 }, desired = { ...config(), mtu: 1340 }
    let disk = live
    mock.invoke.mockImplementation(async (command, args) => {
      if (command === 'save_remote_network_config') { disk = structuredClone(args.cfg); return disk }
      if (command === 'get_saved_remote_config') return structuredClone(disk)
      if (command === 'get_config') return structuredClone(live)
      if (command === 'get_network_metas') return { metas: { [userId]: { network_name: 'User', config_permission: 0, source: 1 } } }
      if (command === 'run_network_instance') return undefined
      throw new Error('unexpected command')
    })
    const options = { offline: () => false, changed: mock.changed, remotePersistence: () => true }
    await new GUIRemoteClient(options).save_config(desired)
    const reconnected = new GUIRemoteClient(options)
    expect((await reconnected.get_network_config(userId)).mtu).toBe(1340)
    await reconnected.update_network_instance_state(userId, false)
    expect(mock.invoke).toHaveBeenCalledWith('run_network_instance', { cfg: expect.objectContaining({ mtu: 1340 }), save: true })
    expect(mock.invoke.mock.calls.some(([command]) => command === 'save_network_config')).toBe(false)
    expect(live.mtu).toBe(1280)
  })

  it('does not report a rejected remote save as success or replace a confirmed save with old live data', async () => {
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, remotePersistence: () => true })
    mock.invoke.mockRejectedValueOnce(new Error('remote file is read-only'))
    await expect(client.save_config(config())).rejects.toThrow('remote file is read-only')
    mock.invoke.mockImplementation(async command => {
      if (command === 'save_remote_network_config') return { ...config(), mtu: 1340 }
      if (command === 'get_network_metas') return { metas: { [userId]: { network_name: 'User', config_permission: 0, source: 1 } } }
      if (command === 'get_saved_remote_config') throw new Error('durable read unavailable')
      throw new Error('old live must not be started')
    })
    await client.save_config({ ...config(), mtu: 1340 })
    await expect(client.get_network_config(userId)).rejects.toThrow('durable read unavailable')
    await expect(client.update_network_instance_state(userId, false)).rejects.toThrow('durable read unavailable')
    expect(mock.invoke.mock.calls.some(([command]) => command === 'run_network_instance')).toBe(false)
  })

  it('does not fall back to live state after reconnecting when durable reads time out', async () => {
    mock.invoke.mockImplementation(async command => {
      if (command === 'get_saved_remote_config') throw new Error('Timeout: deadline has elapsed')
      if (command === 'get_network_metas') return { metas: { [userId]: { network_name: 'User', config_permission: 0, source: 1 } } }
      throw new Error('must not read or start old live configuration')
    })
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, remotePersistence: () => true })
    await expect(client.get_network_config(userId)).rejects.toThrow('Timeout: deadline has elapsed')
    await expect(client.update_network_instance_state(userId, false)).rejects.toThrow('Timeout: deadline has elapsed')
    expect(mock.invoke.mock.calls.every(([command]) => command === 'get_saved_remote_config' || command === 'get_network_metas')).toBe(true)
  })

  it('retains explicit edit-and-run compatibility for an old or pathless Core without claiming durable save support', async () => {
    mock.invoke.mockImplementation(async command => {
      if (command === 'get_saved_remote_config') throw 'REMOTE_PERSISTENCE_UNSUPPORTED'
      if (command === 'get_config') return config()
      if (command === 'get_network_metas') return { metas: { [userId]: { network_name: 'User', config_permission: 0, source: 1 } } }
      if (command === 'update_network_config_state') return undefined
      if (command === 'save_remote_network_config') throw new Error('durable save unsupported')
      throw new Error('unexpected command')
    })
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, remotePersistence: () => true })
    expect((await client.get_network_config(userId)).instance_id).toBe(userId)
    await client.update_network_instance_state(userId, false)
    expect(mock.invoke).toHaveBeenCalledWith('update_network_config_state', { instanceId: userId, disabled: false })
    await expect(client.save_config(config())).rejects.toThrow('durable save unsupported')
  })

  it('observes all real Core runtimes and rejects a late result from an obsolete destination', async () => {
    let current = true
    let finish!: (result: unknown) => void
    mock.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, current: () => current })
    const stale = client.get_network_infos()
    current = false
    finish({ info: { map: { [userId]: { running: true } } } })
    await expect(stale).rejects.toThrow('configuration_context_changed')
    current = true
    mock.invoke.mockResolvedValueOnce({ info: { map: { [userId]: { running: true }, [managedId]: { running: false, error_msg: 'failed' } } } })
    const runtimes = await client.get_network_infos()
    expect(runtimes[userId]).toMatchObject({ running: true, peers: [] })
    expect(runtimes[managedId]).toMatchObject({ running: false, error_msg: 'failed' })
    expect(mock.invoke.mock.calls.every(([command, args]) => command === 'collect_network_info' && Object.keys(args).length === 0)).toBe(true)
  })
  it('validates and saves a disabled local draft without Core, foreground service or enabled-state restoration', async () => {
    const client = createClient(), draft = config()
    saveEnabledNetworks([userId, managedId])
    await client.validate_config(draft)
    await client.save_config(draft)
    expect(mock.invoke.mock.calls.map(([command]) => command)).toEqual(['parse_network_config'])
    expect(mock.prepareVpnService).not.toHaveBeenCalled()
    expect(loadStoredConfigs()[0]).toMatchObject({ source: 'user', config: { instance_id: userId, future_option: { retain: true } } })
    expect(loadEnabledNetworks()).toEqual([managedId])
    expect((await client.list_network_instance_ids()).disabled_inst_ids.map(UuidToStr)).toEqual([userId])
    expect((await client.list_network_instance_ids()).running_inst_ids).toEqual([])
    expect((await client.get_network_metas([userId])).metas[userId].config_permission).toBe(0)
    expect((await client.get_network_config(userId)).network_name).toBe('Offline fixture')
    expect(mock.changed).toHaveBeenCalledOnce()
  })
  it('preserves managed ownership and refuses overwriting or deleting a matching server-owned ID', async () => {
    saveStoredConfigs([{ config: config(managedId), source: 'web' }])
    saveEnabledNetworks([managedId])
    const before = store.get('networkList'), client = createClient()
    await expect(client.save_config(config(managedId))).rejects.toThrow('managed_config_read_only')
    await expect(client.delete_network(managedId)).rejects.toThrow('managed_config_read_only')
    expect(store.get('networkList')).toBe(before)
    expect(loadEnabledNetworks()).toEqual([managedId])
    expect((await client.get_network_metas([managedId])).metas[managedId].config_permission).toBe(3)
    expect(mock.invoke).not.toHaveBeenCalled()
  })
  it('keeps local legacy ownership when editing and removes only the deleted configuration and enabled ID', async () => {
    saveStoredConfigs([{ config: config(), source: 'legacy' }, { config: config(managedId), source: 'web' }])
    const client = createClient()
    await client.save_config({ ...config(), network_name: 'Edited offline' })
    expect(loadStoredConfigs().find(entry => entry.config.instance_id === userId)?.source).toBe('legacy')
    saveEnabledNetworks([userId, managedId])
    await client.delete_network(userId)
    expect(loadStoredConfigs().map(entry => entry.config.instance_id)).toEqual([managedId])
    expect(loadEnabledNetworks()).toEqual([managedId])
    expect(mock.invoke).not.toHaveBeenCalled()
  })
  it('blocks runtime activation before Android permission/service calls while the local client is stopped', async () => {
    const client = createClient()
    await expect(client.run_network(config(), true)).rejects.toThrow('client_not_running')
    await expect(client.update_network_instance_state(userId, false)).rejects.toThrow('client_not_running')
    expect(mock.invoke).not.toHaveBeenCalled()
    expect(mock.prepareVpnService).not.toHaveBeenCalled()
  })
  it('rejects an obsolete local client when its mode changes during validation instead of forwarding the draft', async () => {
    let active = true
    let finish!: (value: string) => void
    mock.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const client = new GUIRemoteClient({ offline: () => true, changed: mock.changed, current: () => active })
    const pending = client.validate_config(config())
    active = false
    finish('network_name = "Offline fixture"')
    await expect(pending).rejects.toThrow('configuration_context_changed')
    await expect(client.save_config(config())).rejects.toThrow('configuration_context_changed')
    await expect(client.get_network_metas([userId])).rejects.toThrow('configuration_context_changed')
    expect(loadStoredConfigs()).toEqual([])
    expect(mock.invoke.mock.calls.map(([command]) => command)).toEqual(['parse_network_config'])
  })
  it('cancels a pending network start if the local client stops while Android permission is pending', async () => {
    let active = true
    let release!: () => void
    mock.prepareVpnService.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const client = new GUIRemoteClient({ offline: () => false, changed: mock.changed, current: () => active })
    const pending = client.run_network(config(), true)
    active = false
    release()
    await expect(pending).rejects.toThrow('network_start_failed')
    expect(mock.invoke).not.toHaveBeenCalled()
  })
  it('does not use a local-storage fallback for a remote/service client or after runtime reconnects', async () => {
    saveStoredConfigs([{ config: config(), source: 'user' }])
    const before = store.get('networkList')
    mock.offline = false
    const client = createClient()
    await expect(client.save_config(config())).rejects.toThrow('runtime unavailable')
    await expect(client.list_network_instance_ids()).rejects.toThrow('runtime unavailable')
    expect(mock.invoke.mock.calls.map(([command]) => command)).toEqual(['save_network_config', 'list_network_instance_ids'])
    expect(store.get('networkList')).toBe(before)
  })
})
