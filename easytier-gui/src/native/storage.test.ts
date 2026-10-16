import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NETWORK_CONFIG } from '../../../easytier-web/frontend-lib/src/types/network'
import { loadEnabledNetworks, loadMode, loadStoredConfigs, parseStoredConfigs, saveEnabledNetworks, saveStoredConfigs, loadLocalClientPaused, saveLocalClientPaused, saveLocalStoredConfig, removeLocalStoredConfig } from './storage'

vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows' }))
const store = new Map<string, string>()
const fixtureId = '00000000-0000-4000-8000-000000000001'
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } })
})
describe('existing GUI persistence migration', () => {
  it('persists a local pause without touching credentials, saved networks or the enabled list', () => {
    const retained = { app_mode: 'fixture-mode-and-token', networkList: 'fixture-configs', enabled_networks: 'fixture-enabled', last_network_instance_id: fixtureId }
    for (const [key, value] of Object.entries(retained)) store.set(key, value)
    expect(loadLocalClientPaused()).toBe(false)
    saveLocalClientPaused(true)
    expect(loadLocalClientPaused()).toBe(true)
    for (const [key, value] of Object.entries(retained)) expect(store.get(key)).toBe(value)
    saveLocalClientPaused(false)
    expect(loadLocalClientPaused()).toBe(false)
  })
  it('edits local entries without normalizing or rewriting untouched managed records', () => {
    const managed = { config: { instance_id: fixtureId, network_name: 'Managed', future: { keep: true } }, source: 'web', extra: 'retained' }
    const localId = '00000000-0000-4000-8000-000000000002'
    store.set('networkList', JSON.stringify([managed]))
    saveLocalStoredConfig({ ...DEFAULT_NETWORK_CONFIG(), instance_id: localId, network_name: 'Local' })
    expect(JSON.parse(store.get('networkList')!)[0]).toEqual(managed)
    removeLocalStoredConfig(localId)
    expect(JSON.parse(store.get('networkList')!)).toEqual([managed])
    expect(() => saveLocalStoredConfig({ ...DEFAULT_NETWORK_CONFIG(), instance_id: fixtureId })).toThrow('managed_config_read_only')
    expect(() => removeLocalStoredConfig(fixtureId)).toThrow('managed_config_read_only')
  })
  it('refuses destructive offline updates when the existing local store is malformed', () => {
    for (const raw of ['{broken', '{"unknown":"format"}']) {
      store.set('networkList', raw)
      expect(() => saveLocalStoredConfig({ ...DEFAULT_NETWORK_CONFIG(), instance_id: fixtureId })).toThrow('local_config_storage_invalid')
      expect(() => removeLocalStoredConfig(fixtureId)).toThrow('local_config_storage_invalid')
      expect(store.get('networkList')).toBe(raw)
    }
  })
  it('loads old bare configurations as legacy without creating new instance IDs', () => {
    const config = { ...DEFAULT_NETWORK_CONFIG(), instance_id: fixtureId }
    store.set('networkList', JSON.stringify([config]))
    expect(loadStoredConfigs()[0].source).toBe('legacy')
    expect(loadStoredConfigs()[0].config.instance_id).toBe(fixtureId)
  })
  it('normalizes webhook source to web and keeps strong ownership when IDs are duplicated', () => {
    const config = { ...DEFAULT_NETWORK_CONFIG(), instance_id: fixtureId }
    const stored = parseStoredConfigs(JSON.stringify([{ config, source: 'webhook' }, { config, source: 'user' }]))
    expect(stored).toHaveLength(1)
    expect(stored[0].source).toBe('web')
  })
  it('handles malformed storage and invalid entries without throwing or overwriting the original', () => {
    store.set('networkList', '{broken-json')
    store.set('app_mode', '{broken-json')
    expect(loadStoredConfigs()).toEqual([])
    expect(loadMode()).toEqual({ mode: 'normal' })
    expect(store.get('networkList')).toBe('{broken-json')
    expect(parseStoredConfigs(JSON.stringify([null, false, 1, { instance_id: 'invalid' }]))).toEqual([])
  })
  it('persists enabled instance IDs from native events and removes invalid duplicates', () => {
    saveEnabledNetworks([fixtureId, fixtureId, 'invalid', 42])
    expect(loadEnabledNetworks()).toEqual([fixtureId])
    saveStoredConfigs([{ config: { ...DEFAULT_NETWORK_CONFIG(), instance_id: fixtureId }, source: 'user' }])
    expect(loadStoredConfigs()[0].config.instance_id).toBe(fixtureId)
  })
  it('clears invalid legacy credentials without implicitly choosing an official server', () => {
    for (const value of ['old-user-name', 'udp://192.0.2.10:22020', { username: 'fixture' }]) {
      store.set('app_mode', JSON.stringify({ mode: 'normal', config_server_url: value }))
      expect(loadMode()).toEqual({ mode: 'normal', config_server_url: undefined, config_server_needs_credentials: true })
    }
  })
  it('preserves a valid token URL when moving an old Windows service configuration to Android normal mode', () => {
    const endpoint = `udp://192.0.2.10:22020/${'A'.repeat(43)}`
    store.set('app_mode', JSON.stringify({ mode: 'service', config_server_url: endpoint, config_dir: 'fixture' }))
    expect(loadMode('android').mode).toBe('normal')
    expect(loadMode('android').config_server_url).toBe(endpoint)
  })
})
