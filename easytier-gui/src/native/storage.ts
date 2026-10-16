import { type as osType } from '@tauri-apps/plugin-os'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import type { ConfigSource, Mode } from './types'
import { buildConfigServerUrl, splitConfigServerUrl } from './config_server_credentials'

export interface StoredGuiConfig { config: Network.NetworkConfig; source: ConfigSource }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeConfigSource(source: unknown): ConfigSource {
  return source === 'web' || source === 'webhook' ? 'web' : source === 'user' ? 'user' : 'legacy'
}

export function parseStoredConfigs(raw: string | null): StoredGuiConfig[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw || '[]') } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const configs = new Map<string, StoredGuiConfig>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const value = 'config' in entry ? entry.config : entry
    if (!value || typeof value !== 'object' || typeof value.instance_id !== 'string'
      || !uuidPattern.test(value.instance_id)) continue
    try {
      const config = Network.normalizeNetworkConfig(value)
      const source = normalizeConfigSource(entry.source)
      const previous = configs.get(config.instance_id)
      configs.set(config.instance_id, { config, source: previous?.source === 'web' ? 'web' : source })
    } catch { /* Keep the original storage intact if an individual entry is invalid. */ }
  }
  return [...configs.values()]
}

export function loadStoredConfigs(): StoredGuiConfig[] {
  return parseStoredConfigs(localStorage.getItem('networkList'))
}
export function saveStoredConfigs(configs: unknown): void {
  const normalized = parseStoredConfigs(JSON.stringify(configs))
  localStorage.setItem('networkList', JSON.stringify(normalized))
}
function editableRawConfigs(id: string): unknown[] {
  const raw = localStorage.getItem('networkList')
  let entries: unknown
  try { entries = JSON.parse(raw || '[]') } catch { throw new Error('local_config_storage_invalid') }
  if (!Array.isArray(entries)) throw new Error('local_config_storage_invalid')
  return entries.filter(entry => {
    if (!entry || typeof entry !== 'object') return true
    const config = 'config' in entry ? entry.config : entry
    if (!config || typeof config !== 'object' || !('instance_id' in config) || config.instance_id !== id) return true
    if ('source' in entry && normalizeConfigSource(entry.source) === 'web') throw new Error('managed_config_read_only')
    return false
  })
}
export function saveLocalStoredConfig(config: Network.NetworkConfig): void {
  const entries = editableRawConfigs(config.instance_id)
  const source = loadStoredConfigs().find(entry => entry.config.instance_id === config.instance_id)?.source ?? 'user'
  const [normalized] = parseStoredConfigs(JSON.stringify([{ config, source }]))
  if (!normalized) throw new Error('local_config_invalid')
  localStorage.setItem('networkList', JSON.stringify([...entries, normalized]))
}
export function removeLocalStoredConfig(id: string): void {
  localStorage.setItem('networkList', JSON.stringify(editableRawConfigs(id)))
}
export function loadEnabledNetworks(): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem('enabled_networks') || '[]')
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && uuidPattern.test(id)) : []
  } catch { return [] }
}
export function saveEnabledNetworks(ids: unknown): void {
  if (!Array.isArray(ids)) return
  localStorage.setItem('enabled_networks', JSON.stringify([...new Set(ids.filter(id => typeof id === 'string' && uuidPattern.test(id)))]))
}
export function loadLastNetworkInstanceId(): string | null { return localStorage.getItem('last_network_instance_id') }
export function saveLastNetworkInstanceId(id: string): void { localStorage.setItem('last_network_instance_id', id) }
export function saveMode(mode: Mode): void { localStorage.setItem('app_mode', JSON.stringify(mode)) }
export function loadLocalClientPaused(): boolean { return localStorage.getItem('local_client_paused') === 'true' }
export function saveLocalClientPaused(paused: boolean): void { localStorage.setItem('local_client_paused', String(paused)) }

export function loadMode(platform = osType()): Mode {
  let mode: Mode
  try {
    const value = JSON.parse(localStorage.getItem('app_mode') || '{}')
    mode = value && ['normal', 'service', 'remote'].includes(value.mode) ? value : { mode: 'normal' }
  } catch { mode = { mode: 'normal' } }
  if (mode.config_server_url && typeof mode.config_server_url !== 'string') {
    mode.config_server_url = undefined
    mode.config_server_needs_credentials = true
  }
  if (mode.config_server_url) {
    const credentials = splitConfigServerUrl(mode.config_server_url)
    if (credentials.legacy) {
      mode.config_server_url = undefined
      mode.config_server_needs_credentials = true
    } else {
      try { mode.config_server_url = buildConfigServerUrl(credentials.address, credentials.token) }
      catch { mode.config_server_url = undefined; mode.config_server_needs_credentials = true }
    }
  }
  return platform === 'android' ? { ...mode, mode: 'normal' } : mode
}
