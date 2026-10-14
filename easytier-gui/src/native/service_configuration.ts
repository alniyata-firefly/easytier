import type { ServiceOptions, ServiceStatus } from './types'

export interface ServiceConfigurationApi {
  getStatus: () => Promise<ServiceStatus>
  setEnabled: (enabled: boolean) => Promise<unknown>
  install: (options?: ServiceOptions) => Promise<unknown>
  ensureReady?: () => Promise<void>
  delay?: () => Promise<void>
}

export class ServiceConfigurationError extends Error {
  constructor(code: string, public readonly restoredStatus?: ServiceStatus) {
    super(code)
  }
}

async function stopService(api: ServiceConfigurationApi) {
  await api.setEnabled(false)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await api.getStatus() === 'Stopped') return
    await (api.delay?.() ?? new Promise(resolve => setTimeout(resolve, 200)))
  }
  throw new Error('service_stop_timeout')
}

/**
 * Windows SCM updates the saved command line without restarting the process.
 * Apply a config change only after the old process has stopped, and restore the
 * previous service options when installation or startup fails. Credentials are
 * passed through privately; errors deliberately exclude the original backend
 * message, which can contain a management URL.
 */
export async function applyServiceConfiguration(
  next: ServiceOptions,
  previous: ServiceOptions | undefined,
  api: ServiceConfigurationApi,
): Promise<ServiceStatus> {
  const originalStatus = await api.getStatus()
  try {
    if (originalStatus === 'Running') await stopService(api)
    await api.install(next)
    let status = await api.getStatus()
    if (status === 'Stopped') {
      await api.setEnabled(true)
      status = await api.getStatus()
    }
    if (status !== 'Running') throw new Error('service_start_failed')
    await api.ensureReady?.()
    return status
  } catch {
    let restoredStatus: ServiceStatus
    try {
      let status = await api.getStatus()
      if (status === 'Running') {
        await stopService(api)
        status = 'Stopped'
      }
      if (previous && originalStatus !== 'NotInstalled') {
        await api.install(previous)
        if (originalStatus === 'Running') await api.setEnabled(true)
      } else if (originalStatus === 'NotInstalled' && status !== 'NotInstalled') {
        // Do not leave a new, partially configured background process behind
        // when the GUI falls back to its previous ordinary mode.
        await api.install(undefined)
      }
      restoredStatus = await api.getStatus()
    } catch {
      throw new ServiceConfigurationError('service_update_and_restore_failed')
    }
    throw new ServiceConfigurationError('service_update_failed', restoredStatus)
  }
}
