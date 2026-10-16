import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined), configs: [{ config: { instance_id: 'fixture' } as Record<string, unknown>, source: 'web' }] }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('../../../easytier-web/frontend-lib/src/types/network', () => ({
  toBackendNetworkConfig: (cfg: unknown) => cfg, normalizeNetworkConfig: (cfg: unknown) => cfg,
}))
vi.mock('./storage', () => ({ loadStoredConfigs: () => mock.configs }))

describe('Tauri native command payload contract', () => {
  it('reads the local persisted management identity without a token or a running instance', async () => {
    const backend = await import('./backend')
    await backend.getManagementDeviceId()
    expect(mock.invoke).toHaveBeenLastCalledWith('get_management_device_id')
  })

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

  it('binds a TUN descriptor to the requested instance instead of choosing another network', async () => {
    const backend = await import('./backend')
    const instanceId = '11111111-1111-4111-8111-111111111111'
    const requestId = 'vpn-start-fixture'
    await backend.setTunFd(42, instanceId, requestId)
    expect(mock.invoke).toHaveBeenLastCalledWith('set_tun_fd', { fd: 42, instanceId, requestId })
    await backend.clearTunFd(instanceId, requestId)
    expect(mock.invoke).toHaveBeenLastCalledWith('clear_tun_fd', { instanceId, requestId })
  })

  it('restores saved mobile configurations with automatic uplinks without changing stored data', async () => {
    const backend = await import('./backend')
    const config = { instance_id: 'mobile-fixture', bind_device: true, uplink: { mode: 'manual', interfaces: ['eth0'] }, mtu: 1280 }
    mock.configs = [{ config, source: 'web' }]
    try {
      await backend.sendConfigs(['mobile-fixture'], false)
      expect(mock.invoke).toHaveBeenLastCalledWith('load_configs', {
        configs: [{ config: { instance_id: 'mobile-fixture', bind_device: false, mtu: 1280 }, source: 'web' }], enabledNetworks: ['mobile-fixture'],
      })
      expect(config.uplink.interfaces).toEqual(['eth0'])
      expect(config.bind_device).toBe(true)
    }
    finally { mock.configs = [{ config: { instance_id: 'fixture' }, source: 'web' }] }
  })
})
