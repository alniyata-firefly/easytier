import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'
import { saveEnabledNetworks, saveStoredConfigs } from './storage'
import { onNetworkInstanceChange, onNetworkInstanceUpdate, prepareVpnService, syncMobileVpnService } from './mobile_vpn'

export function normalizeInstanceIdPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const uuid = payload as Utils.UUID
    if ([uuid.part1, uuid.part2, uuid.part3, uuid.part4].every(part => Number.isInteger(part))) return Utils.UuidToStr(uuid)
  }
  return ''
}
export async function listenGlobalEvents(options: { android: boolean; persist: () => boolean; changed: () => void; error: (code: string) => void }): Promise<() => void> {
  const cleanups: UnlistenFn[] = []
  async function add(name: string, callback: (payload: unknown) => void | Promise<void>) {
    cleanups.push(await listen(name, event => {
      void Promise.resolve().then(() => callback(event.payload)).catch(() => options.error('native_event_failed'))
    }))
  }
  try {
    await add('save_configs', payload => { if (options.persist()) saveStoredConfigs(payload); options.changed() })
    await add('save_enabled_networks', payload => { if (options.persist()) saveEnabledNetworks(payload); options.changed() })
    if (options.android) {
      await add('pre_run_network_instance', payload => prepareVpnService(normalizeInstanceIdPayload(payload)))
      await add('post_run_network_instance', payload => onNetworkInstanceChange(normalizeInstanceIdPayload(payload)))
      await add('vpn_service_stop', () => syncMobileVpnService())
      for (const event of ['dhcp_ip_changed', 'proxy_cidrs_updated', 'event_lagged']) {
        await add(event, payload => onNetworkInstanceUpdate(normalizeInstanceIdPayload(payload)))
      }
    }
    return () => cleanups.splice(0).forEach(cleanup => cleanup())
  } catch { cleanups.forEach(cleanup => cleanup()); throw new Error('native_events_unavailable') }
}
