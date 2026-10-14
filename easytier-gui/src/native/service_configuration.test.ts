import { describe, expect, it } from 'vitest'
import type { ServiceOptions, ServiceStatus } from './types'
import { applyServiceConfiguration, type ServiceConfigurationApi } from './service_configuration'

const fixtureToken = 'A'.repeat(43)
const previous: ServiceOptions = {
  config_dir: 'fixture/config.d', rpc_portal: '127.0.0.1:15999',
  file_log_dir: 'fixture/logs', file_log_level: 'warn',
  config_server: `udp://192.0.2.10:22020/${fixtureToken}`,
}
const next: ServiceOptions = { ...previous, config_server: `udp://192.0.2.20:22020/${fixtureToken}` }

function fixture(initial: ServiceStatus) {
  const state = { status: initial, installed: initial === 'NotInstalled' ? undefined : previous }
  const actions: string[] = []
  const api: ServiceConfigurationApi = {
    getStatus: async () => state.status,
    setEnabled: async enabled => {
      actions.push(enabled ? 'start' : 'stop')
      state.status = enabled ? 'Running' : 'Stopped'
    },
    install: async options => {
      actions.push(options === next ? 'install-next' : options === previous ? 'install-previous' : 'uninstall')
      state.installed = options
      state.status = options ? 'Stopped' : 'NotInstalled'
    },
    delay: async () => undefined,
  }
  return { state, actions, api }
}

describe('Windows service credential updates', () => {
  it('waits for the running process to stop before changing its command line and restarting', async () => {
    const { state, actions, api } = fixture('Running')
    let polls = 0
    api.setEnabled = async enabled => {
      actions.push(enabled ? 'start' : 'stop')
      if (enabled) state.status = 'Running'
    }
    api.getStatus = async () => {
      if (actions[0] === 'stop' && actions.length === 1 && ++polls === 3) state.status = 'Stopped'
      return state.status
    }
    api.install = async options => {
      expect(state.status).toBe('Stopped')
      actions.push(options === next ? 'install-next' : 'install-previous')
      state.installed = options
    }
    expect(await applyServiceConfiguration(next, previous, api)).toBe('Running')
    expect(polls).toBe(3)
    expect(actions).toEqual(['stop', 'install-next', 'start'])
    expect(state.installed).toBe(next)
  })

  it('restores the previous running service if updating the installed configuration fails', async () => {
    const { state, actions, api } = fixture('Running')
    const install = api.install
    api.install = async options => {
      if (options === next) {
        actions.push('install-next-failed')
        throw new Error(`private backend failure ${next.config_server}`)
      }
      return install(options)
    }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['stop', 'install-next-failed', 'install-previous', 'start'])
    expect(state.installed).toBe(previous)
    expect(state.status).toBe('Running')
  })

  it('restores previous credentials after the updated service fails to start', async () => {
    const { state, actions, api } = fixture('Running')
    const setEnabled = api.setEnabled
    let starts = 0
    api.setEnabled = async enabled => {
      if (enabled && starts++ === 0) {
        actions.push('start-next-failed')
        throw new Error(`private backend failure ${next.config_server}`)
      }
      return setEnabled(enabled)
    }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['stop', 'install-next', 'start-next-failed', 'install-previous', 'start'])
    expect(state.installed).toBe(previous)
    expect(state.status).toBe('Running')
  })

  it('leaves an originally stopped service stopped after restoring a failed update', async () => {
    const { state, actions, api } = fixture('Stopped')
    api.setEnabled = async () => {
      actions.push('start-next-failed')
      throw new Error('fixture startup failure')
    }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['install-next', 'start-next-failed', 'install-previous'])
    expect(state.installed).toBe(previous)
    expect(state.status).toBe('Stopped')
  })

  it('removes a partially installed new service before ordinary-mode fallback', async () => {
    const { state, actions, api } = fixture('NotInstalled')
    const install = api.install
    api.install = async options => {
      await install(options)
      if (options === next) throw new Error('fixture partial installation failure')
    }
    await expect(applyServiceConfiguration(next, undefined, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['install-next', 'uninstall'])
    expect(state.installed).toBeUndefined()
    expect(state.status).toBe('NotInstalled')
  })

  it('restores the original running service when RPC or config initialization fails after startup', async () => {
    const { state, actions, api } = fixture('Running')
    api.ensureReady = async () => {
      expect(state.status).toBe('Running')
      expect(state.installed).toBe(next)
      actions.push('rpc-or-config-failed')
      throw new Error(`private readiness failure ${next.config_server}`)
    }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['stop', 'install-next', 'start', 'rpc-or-config-failed', 'stop', 'install-previous', 'start'])
    expect(state.installed).toBe(previous)
    expect(state.status).toBe('Running')
  })

  it('stops and removes a newly installed service when its post-start RPC initialization fails', async () => {
    const { state, actions, api } = fixture('NotInstalled')
    api.ensureReady = async () => { throw new Error('fixture RPC readiness failure') }
    await expect(applyServiceConfiguration(next, undefined, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['install-next', 'start', 'stop', 'uninstall'])
    expect(state.installed).toBeUndefined()
    expect(state.status).toBe('NotInstalled')
  })

  it('restores NotInstalled even when old GUI service options remain in local storage', async () => {
    const { state, actions, api } = fixture('NotInstalled')
    api.ensureReady = async () => { throw new Error('fixture RPC readiness failure') }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_failed$/)
    expect(actions).toEqual(['install-next', 'start', 'stop', 'uninstall'])
    expect(state.installed).toBeUndefined()
    expect(state.status).toBe('NotInstalled')
  })

  it('refuses to overwrite the configuration while a running service will not stop', async () => {
    const { actions, api } = fixture('Running')
    api.setEnabled = async () => { actions.push('stop-not-completed') }
    await expect(applyServiceConfiguration(next, previous, api)).rejects.toThrow(/^service_update_and_restore_failed$/)
    expect(actions).toEqual(['stop-not-completed', 'stop-not-completed'])
  })

  it('treats a missing installed service as a failure, rather than reporting the update applied', async () => {
    const { state, api } = fixture('NotInstalled')
    api.install = async () => undefined
    await expect(applyServiceConfiguration(next, undefined, api)).rejects.toThrow(/^service_update_failed$/)
    expect(state.status).toBe('NotInstalled')
  })
})
