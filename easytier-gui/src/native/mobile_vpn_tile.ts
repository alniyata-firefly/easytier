import type * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import type { VpnTileAction } from '../../../tauri-plugin-vpnservice/guest-js/index'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'

export interface VpnTileActionResult {
  action: VpnTileAction
  instanceId?: string
  changed: boolean
  pending?: boolean
}

export interface VpnTileActionOptions {
  lastInstanceId?: string | null
  syncVpnService: (instanceId?: string) => Promise<void>
}

export async function executeVpnTileAction(
  action: VpnTileAction,
  api: Api.RemoteClient,
  options: VpnTileActionOptions,
): Promise<VpnTileActionResult> {
  const response = await api.list_network_instance_ids()
  const runningIds = (response.running_inst_ids ?? []).map(Utils.UuidToStr)
  const disabledIds = (response.disabled_inst_ids ?? []).map(Utils.UuidToStr)
  const configuredIds = [...new Set([...runningIds, ...disabledIds])]

  const candidateIds = action === 'stop' ? runningIds : configuredIds
  const candidateConfigs = new Map(
    await Promise.all(candidateIds.map(async (instanceId) => {
      const config = await api.get_network_config(instanceId)
      return [instanceId, config] as const
    })),
  )
  const metas = candidateIds.length ? (await api.get_network_metas(candidateIds)).metas : {}
  const isManaged = (id: string) => metas[id]?.source === 2 || metas[id]?.source === 'ConfigSourceWeb'
  const candidates = candidateIds.filter(instanceId => !candidateConfigs.get(instanceId)?.no_tun
    // Only an actual Core instance may select a managed TUN. Cached membership
    // can be obsolete while disconnected; let a fresh controller Run select it.
    && (!isManaged(instanceId) || runningIds.includes(instanceId)))
  const instanceId = options.lastInstanceId && candidates.includes(options.lastInstanceId)
    ? options.lastInstanceId
    : candidates[0]

  if (!instanceId) {
    return { action, changed: false }
  }

  if (isManaged(instanceId)) {
    // The controller owns managed instances. Cached configuration must not
    // revive a removed membership or overwrite a newer desired revision.
    if (action === 'stop') throw new Error('managed_lifecycle_owned_by_controller')
  }

  let changed = false
  if (action === 'start' && !runningIds.includes(instanceId)) {
    await api.update_network_instance_state(instanceId, false)
    changed = true
  }
  else if (action === 'stop') {
    await api.update_network_instance_state(instanceId, true)
    changed = true
  }

  await options.syncVpnService(action === 'start' ? instanceId : undefined)
  return { action, instanceId, changed }
}
