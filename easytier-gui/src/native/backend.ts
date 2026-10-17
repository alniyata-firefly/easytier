import { normalizeUplinkInventory } from '../../../easytier-web/frontend-lib/src/modules/uplinkInventoryRpc'
import { normalizeUplinkForTarget } from '../../../easytier-web/frontend-lib/src/modules/uplinkCapabilities'
import { invoke } from '@tauri-apps/api/core'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import type * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import type { ManagementConnectionState, ServiceOptions, ServiceStatus } from './types'
import type { VpnStatusResponse } from '../../../tauri-plugin-vpnservice/guest-js/index'
import { loadStoredConfigs } from './storage'

export const parseNetworkConfig = (cfg: Network.NetworkConfig) => invoke<string>('parse_network_config', { cfg: Network.toBackendNetworkConfig(cfg) })
export async function generateNetworkConfig(tomlConfig: string) {
  return Network.normalizeNetworkConfig(await invoke<Network.NetworkConfig>('generate_network_config', { tomlConfig }))
}
export const runNetworkInstance = (cfg: Network.NetworkConfig, save: boolean) => invoke('run_network_instance', { cfg: Network.toBackendNetworkConfig(cfg), save })
export const collectNetworkInfo = (instanceId?: string) => invoke<Api.CollectNetworkInfoResponse>('collect_network_info', instanceId ? { instanceId } : {})
export async function getVpnPortalInfo(instanceId: string) {
  const info = await invoke<Network.VpnPortalInfo | undefined>('get_vpn_portal_info', { instanceId })
  return info ? Network.normalizeVpnPortalInfo(info) : undefined
}
export const addVpnPortalClient = (instanceId: string, client: { name: string; virtual_ip: string; groups: string[] }) => invoke('patch_vpn_portal_clients', { instanceId, action: 'add', name: client.name, virtualIp: client.virtual_ip, groups: client.groups })
export const removeVpnPortalClient = (instanceId: string, name: string) => invoke('patch_vpn_portal_clients', { instanceId, action: 'remove', name })
export const clearVpnPortalClients = (instanceId: string) => invoke('patch_vpn_portal_clients', { instanceId, action: 'clear' })
export const setLoggingLevel = (level: string) => invoke('set_logging_level', { level })
export const setTunFd = (fd: number, instanceId?: string, requestId?: string) => invoke('set_tun_fd', { fd, instanceId, requestId })
export const clearTunFd = (instanceId: string, requestId: string) => invoke<void>('clear_tun_fd', { instanceId, requestId })
export const getEasytierVersion = () => invoke<string>('easytier_version')
export const listNetworkInstanceIds = () => invoke<Api.ListNetworkInstanceIdResponse>('list_network_instance_ids')
export const deleteNetworkInstance = (instanceId: string) => invoke('remove_network_instance', { instanceId })
export const updateNetworkConfigState = (instanceId: string, disabled: boolean) => invoke('update_network_config_state', { instanceId, disabled })
export const saveNetworkConfig = (cfg: Network.NetworkConfig) => invoke('save_network_config', { cfg: Network.toBackendNetworkConfig(cfg) })
export async function saveRemoteNetworkConfig(cfg: Network.NetworkConfig): Promise<Network.NetworkConfig> {
  return Network.normalizeNetworkConfig(await invoke('save_remote_network_config', { cfg: Network.toBackendNetworkConfig(cfg) }))
}
export async function getSavedRemoteConfig(instanceId: string): Promise<Network.NetworkConfig> {
  return Network.normalizeNetworkConfig(await invoke('get_saved_remote_config', { instanceId }))
}
export function isRemotePersistenceUnsupported(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === 'REMOTE_PERSISTENCE_UNSUPPORTED'
}
export const validateConfig = (cfg: Network.NetworkConfig) => invoke<Api.ValidateConfigResponse>('validate_config', { config: Network.toBackendNetworkConfig(cfg) })
export async function getConfig(instanceId: string) { return Network.normalizeNetworkConfig(await invoke<Network.NetworkConfig>('get_config', { instanceId })) }
export const sendConfigs = (enabledNetworks: string[], supportsUplinkSelection = true, restoreLocalConfigs = true) => invoke('load_configs', {
  configs: restoreLocalConfigs ? loadStoredConfigs().map(({ config, source }) => ({ config: Network.toBackendNetworkConfig(normalizeUplinkForTarget(config as unknown as Record<string, unknown>, supportsUplinkSelection) as unknown as Network.NetworkConfig), source })) : [],
  enabledNetworks,
})
export const getNetworkMetas = (instanceIds: string[]) => invoke<Api.GetNetworkMetasResponse>('get_network_metas', { instanceIds })
export const initService = (opts?: ServiceOptions) => invoke('init_service', { opts })
export const setServiceStatus = (enable: boolean) => invoke('set_service_status', { enable })
export const getServiceStatus = () => invoke<ServiceStatus>('get_service_status')
export const initRpcConnection = (isNormalMode: boolean, url?: string) => invoke('init_rpc_connection', { isNormalMode, url })
export const isClientRunning = () => invoke<boolean>('is_client_running')
export const initWebClient = (url?: string) => invoke('init_web_client', { url })
export const isWebClientConnected = () => invoke<boolean>('is_web_client_connected')
export const getWebClientStatus = () => invoke<ManagementConnectionState>('get_web_client_status')
export const getManagementDeviceId = () => invoke<string>('get_management_device_id')
export const stopLocalClient = () => invoke<void>('stop_local_client')
export const resumeLocalClient = () => invoke<void>('resume_local_client')
export const isLocalClientEnabled = () => invoke<boolean>('is_local_client_enabled')
export const isLocalVpnConnected = () => invoke<boolean>('is_local_vpn_connected')
export const getLocalVpnStatus = () => invoke<VpnStatusResponse | null>('get_local_vpn_status')

export async function getNetworkInterfaces(instanceId?: string) { return normalizeUplinkInventory(await invoke('get_network_interfaces', { instanceId })) }
