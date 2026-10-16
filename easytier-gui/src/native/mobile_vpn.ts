import type * as NetworkTypes from '../../../easytier-web/frontend-lib/src/types/network'
import { addPluginListener } from '@tauri-apps/api/core'
import { v4 as uuidv4 } from 'uuid'
import * as Utils from '../../../easytier-web/frontend-lib/src/modules/utils'
import {
  consume_vpn_tile_action,
  get_vpn_status,
  prepare_vpn,
  start_vpn,
  stop_vpn,
  set_client_enabled,
  type VpnTileAction,
  type VpnStatusResponse,
} from '../../../tauri-plugin-vpnservice/guest-js/index'
import { clearTunFd, collectNetworkInfo, getConfig, listNetworkInstanceIds, setTunFd } from './backend'

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
interface QueuedVpnUpdate {
  instanceId: string
  generation: number
  canceled: boolean
  promise: Promise<void>
}
let queuedVpnUpdate: QueuedVpnUpdate | undefined
let vpnPermissionRequest: Promise<boolean> | null = null
let vpnTileActionHandler: ((action: VpnTileAction) => Promise<void>) | undefined
let vpnTileActionQueue: Promise<void> = Promise.resolve()

let listenerCleanup: Array<() => Promise<void>> = []
let vpnServiceSuspended = false
interface VpnRequest {
  requestId: string
  instanceId: string
  generation: number
  attachedFd?: number
}
let currentVpnRequest: VpnRequest | undefined
// Cancellation invalidates the JS start owner before its queued Stop runs. Keep
// the Core attachment identity until native exit and confirmed Core detach.
let tunRequestToClear: VpnRequest | undefined
const VPN_TRANSITION_TIMEOUT_MS = 15000

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
  vpnReconcileAttempts = 0
  // DHCP/routes notifications for the same instance are new input for its
  // next reconciliation, not a cancellation of its in-flight native start.
  if (instanceId && desiredVpnInstanceId === instanceId) return vpnReconcileGeneration
  desiredVpnInstanceId = instanceId
  vpnReconcileGeneration += 1
  currentVpnRequest = undefined
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
  // A re-created WebView cannot assume a live native TUN was attached to its
  // current Core. Unknown ownership is stopped before it is started afresh.
  const owner = currentVpnRequest
  const attached = Boolean(owner && matchesRequest(status, owner) && status?.state === 'established'
    && status.established && status.fd === owner.attachedFd && owner.attachedFd !== undefined)
  curVpnStatus.running = owner ? attached : status?.running ?? false
  if (!attached) activeVpnInstanceId = undefined
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

function isCurrentRequest(request: VpnRequest) {
  return !vpnServiceSuspended && currentVpnRequest === request
    && isCurrentVpnReconcile(request.instanceId, request.generation)
}

function matchesRequest(status: VpnStatusResponse | null, request: VpnRequest) {
  return status?.requestId === request.requestId && status.instanceId === request.instanceId
}

function assertCurrentRequest(request: VpnRequest) {
  if (!isCurrentRequest(request)) throw new Error('vpn_request_canceled')
}

async function waitForNativeStart(request: VpnRequest) {
  const deadline = Date.now() + VPN_TRANSITION_TIMEOUT_MS
  while (true) {
    assertCurrentRequest(request)
    const status = await get_vpn_status()
    assertCurrentRequest(request)
    if (matchesRequest(status, request)) {
      if (status?.errorMsg) throw new Error(status.errorMsg)
      if (status?.state === 'established' && status.established) {
        if (!Number.isInteger(status.fd) || status.fd! <= 0) throw new Error('vpn_tun_fd_failed')
        const fd = status.fd!
        tunRequestToClear = request
        try { await setTunFd(fd, request.instanceId, request.requestId) }
        catch { assertCurrentRequest(request); throw new Error('vpn_tun_fd_failed') }
        assertCurrentRequest(request)
        const fresh = await get_vpn_status()
        assertCurrentRequest(request)
        if (!matchesRequest(fresh, request) || fresh?.state !== 'established' || !fresh.established || fresh.fd !== fd)
          throw new Error('vpn_request_canceled')
        request.attachedFd = fd
        return
      }
      if (status?.state === 'stopped') throw new Error('vpn_start_failed')
    }
    // Inspect native truth before the deadline: a WebView suspended by Android
    // may resume long after the service established without delivering an event.
    if (Date.now() >= deadline) throw new Error('vpn_start_timeout')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function clearCoreTunRequest(request: VpnRequest | undefined) {
  if (!request) return
  try { await clearTunFd(request.instanceId, request.requestId) }
  catch { throw new Error('vpn_stop_failed') }
  if (tunRequestToClear === request) tunRequestToClear = undefined
}

async function doStopVpn(force = false) {
  const request = tunRequestToClear ?? currentVpnRequest
  currentVpnRequest = undefined
  const wasRunning = curVpnStatus.running
  if (!force && !wasRunning && !request) {
    activeVpnInstanceId = undefined
    return
  }
  console.log('stop vpn')
  const response = await stop_vpn()
  if (response?.errorMsg) throw new Error('vpn_stop_failed')
  // The event is advisory: Android may stop a service before its WebView
  // listener is attached, or a listener may have been recreated on resume.
  const deadline = Date.now() + VPN_TRANSITION_TIMEOUT_MS
  while (true) {
    const status = await get_vpn_status()
    if (!status || typeof status.running !== 'boolean') throw new Error('vpn_stop_status_unavailable')
    if (status.state === 'stopped' && !status.running) {
      if (status.errorMsg === 'vpn_stop_failed') throw new Error('vpn_stop_failed')
      break
    }
    if (Date.now() >= deadline) throw new Error('vpn_stop_timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await clearCoreTunRequest(request)
  curVpnStatus.running = false
  activeVpnInstanceId = undefined
  resetVpnConfigStatus()
}

async function doStartVpn(instanceId: string, generation: number, ipv4Addr: string, cidr: number, routes: string[], dns?: string) {
  if (curVpnStatus.running) {
    return
  }

  // A stale native service can outlive a WebView. Confirm its destruction before
  // allocating a new request; STARTING/STOPPING is never equivalent to stopped.
  const existing = await get_vpn_status()
  if (!isCurrentVpnReconcile(instanceId, generation) || vpnServiceSuspended) throw new Error('vpn_request_canceled')
  if (existing?.state !== 'stopped' || existing.running || tunRequestToClear) await doStopVpn(true)
  if (!isCurrentVpnReconcile(instanceId, generation) || vpnServiceSuspended) throw new Error('vpn_request_canceled')
  const owner: VpnRequest = { requestId: uuidv4(), instanceId, generation }
  currentVpnRequest = owner
  const request = {
    requestId: owner.requestId,
    instanceId,
    ipv4Addr: `${ipv4Addr}/${cidr}`,
    routes,
    dns,
    disallowedApplications: [],
    mtu: 1300,
  }

  try {
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
    await waitForNativeStart(owner)
    assertCurrentRequest(owner)

    curVpnStatus.running = true
    curVpnStatus.ipv4Addr = ipv4Addr
    curVpnStatus.ipv4Cidr = cidr
    curVpnStatus.routes = routes
    curVpnStatus.dns = dns
    activeVpnInstanceId = instanceId
  } catch (error) {
    // An old request must never stop a newer native owner or overwrite its UI.
    const status = await get_vpn_status().catch(() => null)
    let stopFailed = false
    try {
      if (matchesRequest(status, owner)) await doStopVpn(true)
      else if (tunRequestToClear === owner && status?.requestId && status.requestId !== owner.requestId)
        await clearCoreTunRequest(owner)
    } catch { stopFailed = true }
    if (!currentVpnRequest || currentVpnRequest === owner) {
      if (queuedVpnUpdate?.instanceId === instanceId && queuedVpnUpdate.generation === generation) {
        queuedVpnUpdate.canceled = true
        queuedVpnUpdate = undefined
      }
      if (stopFailed) throw new Error('vpn_stop_failed')
      currentVpnRequest = undefined
      curVpnStatus.running = false
      activeVpnInstanceId = undefined
      resetVpnConfigStatus()
    }
    const code = error instanceof Error ? error.message : ''
    throw new Error(['vpn_permission_denied', 'vpn_request_canceled', 'vpn_tun_fd_failed', 'vpn_foreground_start_failed',
      'vpn_tun_start_failed', 'vpn_service_busy', 'vpn_start_timeout'].includes(code) ? code : 'vpn_start_failed')
  }
}

async function onVpnServiceStart(_payload: unknown) {
  // Advisory only. The bounded start operation reads the authoritative native
  // snapshot and attaches exactly its request's descriptor; delayed events from
  // an earlier start cannot perform any mutation, including after Resume.
}

async function onVpnServiceStop(payload: { requestId?: string; instanceId?: string }) {
  const request = currentVpnRequest
  if (!request || !matchesRequest(payload as VpnStatusResponse, request)) return
  const status = await get_vpn_status()
  if (!isCurrentRequest(request) || !matchesRequest(status, request) || status?.state !== 'stopped' || status.running) return
  await clearCoreTunRequest(request)
  if (!isCurrentRequest(request)) return
  currentVpnRequest = undefined
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

async function reconcileNetworkInstance(instanceId: string, generation: number, strict = false) {
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
    if (strict) throw new Error('vpn_instance_failed')
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
      if (strict) throw e
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

function enqueueVpnReconcile(instanceId: string, generation: number, strict = false) {
  return enqueueVpnTask(() => reconcileNetworkInstance(instanceId, generation, strict))
}

function enqueueVpnUpdate(instanceId: string, generation: number) {
  if (queuedVpnUpdate?.instanceId === instanceId && queuedVpnUpdate.generation === generation)
    return queuedVpnUpdate.promise

  const update: QueuedVpnUpdate = { instanceId, generation, canceled: false, promise: Promise.resolve() }
  update.promise = enqueueVpnTask(async () => {
    if (queuedVpnUpdate === update) queuedVpnUpdate = undefined
    if (!update.canceled) await reconcileNetworkInstance(instanceId, generation)
  })
  queuedVpnUpdate = update
  return update.promise
}

export async function onNetworkInstanceChange(instanceId: string, options: { strict?: boolean } = {}) {
  if (vpnServiceSuspended) return
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

  await enqueueVpnReconcile(instanceId, generation, options.strict)
}

export async function onNetworkInstanceUpdate(instanceId: string) {
  if (vpnServiceSuspended) return
  if (!instanceId || instanceId !== desiredVpnInstanceId)
    return

  const generation = beginVpnReconcile(instanceId)
  await enqueueVpnUpdate(instanceId, generation)
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
  if (vpnServiceSuspended) throw new Error('vpn_request_canceled')
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

export async function syncMobileVpnService(options: { strict?: boolean } = {}) {
  if (vpnServiceSuspended) return
  syncVpnStatusFromNative(await get_vpn_status())
  const instanceId = await findRunningTunInstanceId()
  if (instanceId) {
    console.log('vpn service sync selected instance', instanceId)
    await onNetworkInstanceChange(instanceId, options)
    return
  }

  await onNetworkInstanceChange('')
}

export async function suspendMobileVpnService() {
  vpnServiceSuspended = true
  beginVpnReconcile(undefined)
  const foreground = set_client_enabled(false).then(response => {
    if (response?.errorMsg) throw new Error('client_foreground_stop_failed')
  })
  const vpn = enqueueVpnTask(() => doStopVpn(true))
  const results = await Promise.allSettled([foreground, vpn])
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

export async function resumeMobileVpnService() {
  const response = await set_client_enabled(true)
  if (response?.errorMsg) throw new Error('client_foreground_start_failed')
  vpnServiceSuspended = false
}
