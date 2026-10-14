import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ callbacks: new Map<string, (event: { payload: unknown }) => void>(), cleanup: vi.fn(), saveEnabled: vi.fn(), saveConfigs: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => { fixture.callbacks.set(name, callback); return fixture.cleanup }) }))
vi.mock('./storage', () => ({ saveEnabledNetworks: fixture.saveEnabled, saveStoredConfigs: fixture.saveConfigs }))
vi.mock('./mobile_vpn', () => ({ onNetworkInstanceChange: vi.fn(), onNetworkInstanceUpdate: vi.fn(), prepareVpnService: vi.fn(), syncMobileVpnService: vi.fn() }))
beforeEach(() => { fixture.callbacks.clear(); vi.clearAllMocks() })
describe('native persistence events', () => {
  it('listens to enabled-network updates and respects the current local/remote persistence boundary', async () => {
    const { listenGlobalEvents } = await import('./events')
    let local = true
    const changed = vi.fn()
    const cleanup = await listenGlobalEvents({ android: false, persist: () => local, changed, error: vi.fn() })
    fixture.callbacks.get('save_enabled_networks')!({ payload: ['fixture-id'] })
    await vi.waitFor(() => expect(fixture.saveEnabled).toHaveBeenCalledWith(['fixture-id']))
    local = false
    fixture.callbacks.get('save_enabled_networks')!({ payload: ['remote-id'] })
    fixture.callbacks.get('save_configs')!({ payload: [{ source: 'web' }] })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3))
    expect(fixture.saveEnabled).toHaveBeenCalledOnce()
    expect(fixture.saveConfigs).not.toHaveBeenCalled()
    cleanup()
    expect(fixture.cleanup).toHaveBeenCalledTimes(2)
  })
})
