import type * as NetworkTypes from '../../../easytier-web/frontend-lib/src/types/network'
import { addPluginListener } from '@tauri-apps/api/core'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'
import {
  consume_vpn_tile_action,
  get_vpn_status,
  prepare_vpn,
  start_vpn,
  stop_vpn,
  type VpnTileAction,
} from '../../../tauri-plugin-vpnservice/guest-js/index'
import { collectNetworkInfo, getConfig, listNetworkInstanceIds, setTunFd } from './backend'

type Route = NetworkTypes.Route

interface vpnStatus {
  running: boolean
  ipv4Addr: string | null | undefined
  ipv4Cidr: number | null | undefined
  routes: string[]
  dns: string | null | undefined
}

let vpnReconcileTimer: ReturnType<typeof setTimeout> | null = null
const VPN_RECONCILE_INTERVAL_MS = 2000
const VPN_RECONCILE_MAX_ATTEMPTS = 60

let desiredVpnInstanceId: string | undefined
let activeVpnInstanceId: string | undefined
let vpnReconcileGeneration = 0
let vpnReconcileAttempts = 0
let vpnReconcileQueue: Promise<void> = Promise.resolve()
let vpnPermissionRequest: Promise<boolean> | null = null
let vpnTileActionHandler: ((action: VpnTileAction) => Promise<void>) | undefined
let vpnTileActionQueue: Promise<void> = Promise.resolve()

let listenerCleanup: Array<() => Promise<void>> = []
let tunFdError = false

const curVpnStatus: vpnStatus = {
  running: false,
  ipv4Addr: undefined,
  ipv4Cidr: undefined,
  routes: [],
  dns: undefined,
}

export function setMobileVpnTileActionHandler(
  handler?: (action: VpnTileAction) => Promise<void>,
) {
  vpnTileActionHandler = handler
}

export async function consumePendingMobileVpnTileAction() {
  const handler = vpnTileActionHandler
  if (!handler) {
    return false
  }

  const action = (await consume_vpn_tile_action())?.action
  if (action !== 'start' && action !== 'stop') {
    return false
  }

  const run = vpnTileActionQueue
    .catch(() => console.error('previous VPN tile action failed'))
    .then(() => handler(action))
  vpnTileActionQueue = run.catch(() => console.error('VPN tile action failed'))
  await run
  return true
}

async function requestVpnPermissionOnce() {
  console.log('prepare vpn')
  const prepare_ret = await prepare_vpn()
  if (prepare_ret?.errorMsg?.length) {
    throw new Error(prepare_ret.errorMsg)
  }

  const granted = prepare_ret?.granted ?? true
  if (!granted) {
    console.info('vpn permission request was denied or dismissed')
  }

  return granted
}

async function requestVpnPermission() {
  if (vpnPermissionRequest) {
    console.log('reuse pending vpn permission request')
    return await vpnPermissionRequest
  }

  const request = requestVpnPermissionOnce()
  vpnPermissionRequest = request
  try {
    return await request
  }
  finally {
    if (vpnPermissionRequest === request) {
      vpnPermissionRequest = null
    }
  }
}

function clearVpnReconcileTimer() {
  if (vpnReconcileTimer) {
    clearTimeout(vpnReconcileTimer)
    vpnReconcileTimer = null
  }
}

function beginVpnReconcile(instanceId?: string) {
  clearVpnReconcileTimer()
  desiredVpnInstanceId = instanceId
  vpnReconcileAttempts = 0
  vpnReconcileGeneration += 1
  return vpnReconcileGeneration
}

function isCurrentVpnReconcile(instanceId: string, generation: number) {
  return desiredVpnInstanceId === (instanceId || undefined) && vpnReconcileGeneration === generation
}

function scheduleVpnReconcile(instanceId: string, generation: number, reason: string) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  if (vpnReconcileAttempts >= VPN_RECONCILE_MAX_ATTEMPTS) {
    console.error(
      'vpn service reconcile stopped after maximum attempts',
      instanceId,
      VPN_RECONCILE_MAX_ATTEMPTS,
      reason,
    )
    return
  }

  clearVpnReconcileTimer()
  vpnReconcileAttempts += 1
  console.log(
    'vpn service is not ready, retrying',
    JSON.stringify({
      instanceId,
      attempt: vpnReconcileAttempts,
      maxAttempts: VPN_RECONCILE_MAX_ATTEMPTS,
      delayMs: VPN_RECONCILE_INTERVAL_MS,
      reason,
    }),
  )
  vpnReconcileTimer = setTimeout(() => {
    vpnReconcileTimer = null
    void enqueueVpnReconcile(instanceId, generation)
  }, VPN_RECONCILE_INTERVAL_MS)
}

function resetVpnConfigStatus() {
  curVpnStatus.ipv4Addr = undefined
  curVpnStatus.ipv4Cidr = undefined
  curVpnStatus.routes = []
  curVpnStatus.dns = undefined
}

function syncVpnStatusFromNative(status: Awaited<ReturnType<typeof get_vpn_status>>) {
  curVpnStatus.running = status?.running ?? false
  if (!curVpnStatus.running) {
    activeVpnInstanceId = undefined
    resetVpnConfigStatus()
    return
  }

  const ipv4WithCidr = status?.ipv4Addr
  if (ipv4WithCidr?.length) {
    const [ipv4Addr, cidr] = ipv4WithCidr.split('/')
    curVpnStatus.ipv4Addr = ipv4Addr

    const parsedCidr = Number(cidr)
    curVpnStatus.ipv4Cidr = Number.isInteger(parsedCidr) ? parsedCidr : undefined
  }
  else {
    curVpnStatus.ipv4Addr = undefined
    curVpnStatus.ipv4Cidr = undefined
  }

  curVpnStatus.routes = [...(status?.routes ?? [])]
  curVpnStatus.dns = status?.dns ?? undefined
}

async function waitVpnStatus(target_status: boolean, timeout_sec: number) {
  const start_time = Date.now()
  while (curVpnStatus.running !== target_status) {
    if (target_status && tunFdError) throw new Error('vpn_tun_fd_failed')
    if (Date.now() - start_time > timeout_sec * 1000) {
      throw new Error('wait vpn status timeout')
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

async function doStopVpn(force = false) {
  const wasRunning = curVpnStatus.running
  if (!force && !wasRunning) {
    activeVpnInstanceId = undefined
    return
  }
  console.log('stop vpn')
  await stop_vpn()
  if (wasRunning) {
    await waitVpnStatus(false, 3)
  }

  activeVpnInstanceId = undefined
  resetVpnConfigStatus()
}

async function doStartVpn(instanceId: string, generation: number, ipv4Addr: string, cidr: number, routes: string[], dns?: string) {
  if (curVpnStatus.running) {
    return
  }

  console.log('start vpn service', ipv4Addr, cidr, routes, dns)
  const request = {
    ipv4Addr: `${ipv4Addr}/${cidr}`,
    routes,
    dns,
    disallowedApplications: ['com.kkrainbow.easytier'],
    mtu: 1300,
  }

  try {
    tunFdError = false
    if (!isCurrentVpnReconcile(instanceId, generation)) throw new Error('vpn_request_canceled')
    let start_ret = await start_vpn(request)
    if (start_ret?.errorMsg === 'need_prepare') {
      const granted = await requestVpnPermission()
      if (!granted) {
        throw new Error('vpn_permission_denied')
      }
      if (!isCurrentVpnReconcile(instanceId, generation)) throw new Error('vpn_request_canceled')
      start_ret = await start_vpn(request)
    }

    if (start_ret?.errorMsg?.length) {
      throw new Error(start_ret.errorMsg)
    }
    if (tunFdError) throw new Error('vpn_tun_fd_failed')
    await waitVpnStatus(true, 3)

    curVpnStatus.ipv4Addr = ipv4Addr
    curVpnStatus.ipv4Cidr = cidr
    curVpnStatus.routes = routes
    curVpnStatus.dns = dns
    activeVpnInstanceId = instanceId
  } catch (error) {
    if (!tunFdError) await stop_vpn().catch(() => undefined)
    curVpnStatus.running = false
    activeVpnInstanceId = undefined
    resetVpnConfigStatus()
    const code = error instanceof Error ? error.message : ''
    throw new Error(['vpn_permission_denied', 'vpn_request_canceled', 'vpn_tun_fd_failed'].includes(code) ? code : 'vpn_start_failed')
  }
}

async function onVpnServiceStart(payload: { fd?: number }) {
  if (!Number.isInteger(payload.fd) || payload.fd! < 0) {
    tunFdError = true
    curVpnStatus.running = false
    await stop_vpn().catch(() => undefined)
    return
  }
  try {
    await setTunFd(payload.fd!)
    tunFdError = false
    curVpnStatus.running = true
  } catch {
    tunFdError = true
    curVpnStatus.running = false
    activeVpnInstanceId = undefined
    resetVpnConfigStatus()
    await stop_vpn().catch(() => undefined)
  }
}

async function onVpnServiceStop(_payload: unknown) {
  console.log('vpn service stop')
  curVpnStatus.running = false
  activeVpnInstanceId = undefined
  resetVpnConfigStatus()
}

async function registerVpnServiceListener() {
  console.log('register vpn service listener')
  { const listener = await addPluginListener(
    'vpnservice',
    'vpn_service_start',
    onVpnServiceStart,
  ); listenerCleanup.push(() => listener.unregister()) }

  { const listener = await addPluginListener(
    'vpnservice',
    'vpn_service_stop',
    onVpnServiceStop,
  ); listenerCleanup.push(() => listener.unregister()) }

  { const listener = await addPluginListener(
    'vpnservice',
    'vpn_tile_action',
    () => {
      void consumePendingMobileVpnTileAction().catch(() => {
        console.error('consume VPN tile action failed')
      })
    },
  ); listenerCleanup.push(() => listener.unregister()) }
}

function getRoutesForVpn(routes: Route[] | undefined, node_config: NetworkTypes.NetworkConfig): string[] {
  const ret = []
  for (const r of routes ?? []) {
    for (let cidr of r.proxy_cidrs ?? []) {
      if (!cidr.includes('/')) {
        cidr += cidr.includes(':') ? '/128' : '/32'
      }
      ret.push(cidr)
    }
  }

  for (const route of node_config.routes ?? []) {
    ret.push(route)
  }

  if (node_config.enable_magic_dns) {
    ret.push('100.100.100.101/32')
  }

  // sort and dedup
  return Array.from(new Set(ret)).sort()
}

async function stopVpnOwnedByOtherInstance(instanceId: string, generation: number) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return false

  if (curVpnStatus.running && activeVpnInstanceId !== instanceId) {
    console.warn('vpn service owner changed', activeVpnInstanceId, instanceId)
    await doStopVpn()
  }

  return isCurrentVpnReconcile(instanceId, generation)
}

async function reconcileNetworkInstance(instanceId: string, generation: number) {
  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  clearVpnReconcileTimer()

  if (!instanceId) {
    console.warn('vpn service skipped because instance id is empty')
    if (curVpnStatus.running) {
      await doStopVpn()
    }
    return
  }
  const config = await getConfig(instanceId)
  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  console.log('vpn service loaded config', instanceId, JSON.stringify({
    no_tun: config.no_tun,
    dhcp: config.dhcp,
    enable_magic_dns: config.enable_magic_dns,
  }))
  if (config.no_tun) {
    console.log('vpn service skipped because no_tun is enabled', instanceId)
    if (activeVpnInstanceId === instanceId) {
      await doStopVpn()
    }
    return
  }

  if (!await stopVpnOwnedByOtherInstance(instanceId, generation))
    return

  let curNetworkInfo
  try {
    curNetworkInfo = (await collectNetworkInfo(instanceId))?.info?.map?.[instanceId]
  }
  catch (e) {
    console.warn('vpn service network info query failed', instanceId)
    scheduleVpnReconcile(instanceId, generation, 'network_info_query_failed')
    return
  }

  if (!isCurrentVpnReconcile(instanceId, generation))
    return

  if (!curNetworkInfo) {
    scheduleVpnReconcile(instanceId, generation, 'network_info_unavailable')
    return
  }

  if (curNetworkInfo.error_msg?.length) {
    console.warn('vpn service skipped because network instance failed', instanceId)
    vpnReconcileAttempts = 0
    await doStopVpn()
    return
  }

  const virtualIpv4 = curNetworkInfo.my_node_info?.virtual_ipv4
  const virtual_ip = virtualIpv4?.address?.addr ? Utils.ipv4ToString(virtualIpv4.address) : undefined

  if (!virtual_ip || !virtual_ip.length) {
    scheduleVpnReconcile(
      instanceId,
      generation,
      config.dhcp ? 'dhcp_ipv4_unavailable' : 'static_ipv4_unavailable',
    )
    return
  }

  vpnReconcileAttempts = 0

  let network_length = virtualIpv4?.network_length
  if (!network_length) {
    network_length = 24
  }

  const routes = getRoutesForVpn(curNetworkInfo?.routes, config)

  const dns = config.enable_magic_dns ? '100.100.100.101' : undefined

  const ipChanged = virtual_ip !== curVpnStatus.ipv4Addr
  const cidrChanged = network_length !== curVpnStatus.ipv4Cidr
  const routesChanged = JSON.stringify(routes) !== JSON.stringify(curVpnStatus.routes)
  const dnsChanged = dns != curVpnStatus.dns
  const configChanged = ipChanged || cidrChanged || routesChanged || dnsChanged
  const shouldStartVpn = !curVpnStatus.running

  if (shouldStartVpn || configChanged) {
    console.info('vpn service virtual ip changed', JSON.stringify(curVpnStatus), virtual_ip)
    if (curVpnStatus.running) {
      try {
        await doStopVpn()
      }
      catch (e) {
        console.error('stop vpn service failed')
      }
    }

    try {
      if (!isCurrentVpnReconcile(instanceId, generation))
        return

      await doStartVpn(instanceId, generation, virtual_ip, network_length, routes, dns)
      if (!isCurrentVpnReconcile(instanceId, generation) && activeVpnInstanceId === instanceId) {
        await doStopVpn()
      }
    }
    catch (e) {
      if (e instanceof Error && e.message === 'need_prepare') {
        console.info('vpn permission is required before starting the Android VPN service')
        return
      }
      if (e instanceof Error && e.message === 'vpn_permission_denied') {
        console.info('vpn permission request was denied or dismissed')
        return
      }
      console.error('start vpn service failed')
    }
  }
}

function enqueueVpnTask(task: () => Promise<void>) {
  const run = vpnReconcileQueue
    .catch(() => {
      console.error('previous vpn service reconcile failed')
    })
    .then(task)
  vpnReconcileQueue = run.catch(() => {
    console.error('vpn service reconcile failed')
  })
  return run
}

function enqueueVpnReconcile(instanceId: string, generation: number) {
  return enqueueVpnTask(() => reconcileNetworkInstance(instanceId, generation))
}

export async function onNetworkInstanceChange(instanceId: string) {
  const generation = beginVpnReconcile(instanceId || undefined)

  if (instanceId && await isNoTunEnabled(instanceId)) {
    if (vpnReconcileGeneration !== generation)
      return

    if (activeVpnInstanceId === instanceId) {
      desiredVpnInstanceId = undefined
      await enqueueVpnReconcile('', generation)
      return
    }

    desiredVpnInstanceId = activeVpnInstanceId
    if (activeVpnInstanceId) {
      await enqueueVpnReconcile(activeVpnInstanceId, generation)
    }
    return
  }

  if (vpnReconcileGeneration !== generation)
    return

  await enqueueVpnReconcile(instanceId, generation)
}

export async function onNetworkInstanceUpdate(instanceId: string) {
  if (!instanceId || instanceId !== desiredVpnInstanceId)
    return

  const generation = beginVpnReconcile(instanceId)
  await enqueueVpnReconcile(instanceId, generation)
}

async function isNoTunEnabled(instanceId: string | undefined) {
  if (!instanceId) {
    return false
  }
  return (await getConfig(instanceId)).no_tun ?? false
}

async function findRunningTunInstanceId() {
  const instanceIds = await listNetworkInstanceIds()
  const runningIds = (instanceIds.running_inst_ids ?? []).map(Utils.UuidToStr)
  console.log('vpn service sync running instances', JSON.stringify(runningIds))

  for (const instanceId of runningIds) {
    if (await isNoTunEnabled(instanceId)) {
      continue
    }

    return instanceId
  }

  return undefined
}

export async function initMobileVpnService(): Promise<() => void> {
  if (listenerCleanup.length) return disposeMobileVpnService
  try { await registerVpnServiceListener() }
  catch { disposeMobileVpnService(); throw new Error('vpn_listener_failed') }
  return disposeMobileVpnService
}

export function disposeMobileVpnService() {
  beginVpnReconcile(undefined)
  vpnTileActionHandler = undefined
  listenerCleanup.splice(0).forEach(cleanup => void cleanup().catch(() => undefined))
}

export async function prepareVpnService(instanceId: string, config?: NetworkTypes.NetworkConfig) {
  if (config ? config.no_tun : await isNoTunEnabled(instanceId).catch(() => false)) {
    return
  }

  const requestedGeneration = vpnReconcileGeneration
  if (!await requestVpnPermission()) throw new Error('vpn_permission_denied')
  if (requestedGeneration !== vpnReconcileGeneration && desiredVpnInstanceId !== instanceId) throw new Error('vpn_request_canceled')
  if (desiredVpnInstanceId === instanceId) return
  const generation = beginVpnReconcile(instanceId)
  await enqueueVpnTask(async () => {
    await stopVpnOwnedByOtherInstance(instanceId, generation)
  })
}

export async function syncMobileVpnService() {
  syncVpnStatusFromNative(await get_vpn_status())
  const instanceId = await findRunningTunInstanceId()
  if (instanceId) {
    console.log('vpn service sync selected instance', instanceId)
    await onNetworkInstanceChange(instanceId)
    return
  }

  await onNetworkInstanceChange('')
}
