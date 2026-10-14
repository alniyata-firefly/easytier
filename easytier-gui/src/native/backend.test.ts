import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('../../../easytier-web/frontend-lib/src/types/network', () => ({
  toBackendNetworkConfig: (cfg: unknown) => cfg, normalizeNetworkConfig: (cfg: unknown) => cfg,
}))
vi.mock('./storage', () => ({ loadStoredConfigs: () => [{ config: { instance_id: 'fixture' }, source: 'web' }] }))

describe('Tauri native command payload contract', () => {
  it('uses the Rust parameter names for validation, generation and saving', async () => {
    const backend = await import('./backend')
    const config = { instance_id: 'fixture' } as unknown as Parameters<typeof backend.validateConfig>[0]
    await backend.validateConfig(config)
    expect(mock.invoke).toHaveBeenLastCalledWith('validate_config', { config })
    await backend.parseNetworkConfig(config)
    expect(mock.invoke).toHaveBeenLastCalledWith('parse_network_config', { cfg: config })
    await backend.saveNetworkConfig(config)
    expect(mock.invoke).toHaveBeenLastCalledWith('save_network_config', { cfg: config })
    await backend.generateNetworkConfig('fixture-toml')
    expect(mock.invoke).toHaveBeenLastCalledWith('generate_network_config', { tomlConfig: 'fixture-toml' })
  })

  it('preserves central configuration source and the enabled list in load_configs', async () => {
    const backend = await import('./backend')
    await backend.sendConfigs(['fixture'])
    expect(mock.invoke).toHaveBeenLastCalledWith('load_configs', { configs: [{ config: { instance_id: 'fixture' }, source: 'web' }], enabledNetworks: ['fixture'] })
    await backend.updateNetworkConfigState('fixture', false)
    expect(mock.invoke).toHaveBeenLastCalledWith('update_network_config_state', { instanceId: 'fixture', disabled: false })
  })
})
