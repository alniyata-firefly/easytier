import { beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ os: 'windows' }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => platform.os }))

// Fixture only: never use a live management credential in frontend tests.
const fixtureToken = 'A'.repeat(43)
const managementUrl = `udp://192.0.2.10:22020/${fixtureToken}`
const store = new Map<string, string>()

beforeEach(() => {
  platform.os = 'windows'
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  })
})

describe('GUI config server credentials in persisted modes', () => {
  it('keeps a complete token URL in an existing normal-mode configuration', async () => {
    const { loadMode } = await import('./mode')
    store.set('app_mode', JSON.stringify({ mode: 'normal', config_server_url: managementUrl }))
    expect(loadMode()).toEqual({ mode: 'normal', config_server_url: managementUrl })
  })

  it('preserves service options and token URL for Windows background operation', async () => {
    const { loadMode, saveMode } = await import('./mode')
    const saved = {
      mode: 'service' as const,
      config_dir: 'C:\\fixture\\config.d',
      rpc_portal: '127.0.0.1:15999',
      file_log_level: 'warn' as const,
      file_log_dir: 'C:\\fixture\\logs',
      installed_core_version: 'fixture-version',
      config_server_url: managementUrl,
    }
    saveMode(saved)
    expect(loadMode()).toEqual(saved)
  })

  it('switches saved service mode to normal on Android without losing the token connection', async () => {
    const { loadMode } = await import('./mode')
    platform.os = 'android'
    store.set('app_mode', JSON.stringify({ mode: 'service', config_server_url: managementUrl }))
    expect(loadMode()).toEqual({ mode: 'normal', config_server_url: managementUrl })
  })

  it('disables old username-only registration instead of implicitly using the official server', async () => {
    const { loadMode } = await import('./mode')
    store.set('app_mode', JSON.stringify({ mode: 'normal', config_server_url: 'fixture-user' }))
    expect(loadMode()).toEqual({
      mode: 'normal', config_server_url: undefined, config_server_needs_credentials: true,
    })
  })

  it('does not carry an old username into central registration after switching from remote mode', async () => {
    const { loadMode } = await import('./mode')
    store.set('app_mode', JSON.stringify({
      mode: 'remote', remote_rpc_address: 'tcp://127.0.0.1:15999', config_server_url: 'fixture-user',
    }))
    expect(loadMode()).toEqual({
      mode: 'remote', remote_rpc_address: 'tcp://127.0.0.1:15999',
      config_server_url: undefined, config_server_needs_credentials: true,
    })
  })

  it('requires new credentials for an incomplete saved server URL', async () => {
    const { loadMode } = await import('./mode')
    store.set('app_mode', JSON.stringify({ mode: 'normal', config_server_url: 'udp://192.0.2.10:22020' }))
    expect(loadMode()).toEqual({
      mode: 'normal', config_server_url: undefined, config_server_needs_credentials: true,
    })
  })

  it('keeps an intentionally disconnected client disconnected', async () => {
    const { loadMode, saveMode } = await import('./mode')
    saveMode({ mode: 'normal' })
    expect(loadMode()).toEqual({ mode: 'normal' })
  })
})
