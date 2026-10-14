import { invoke } from '@tauri-apps/api/core'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import type * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import type { ServiceOptions, ServiceStatus } from './types'
import { loadStoredConfigs } from './storage'

export const parseNetworkConfig = (cfg: Network.NetworkConfig) => invoke<string>('parse_network_config', { cfg: Network.toBackendNetworkConfig(cfg) })
export async function generateNetworkConfig(tomlConfig: string) {
  return Network.normalizeNetworkConfig(await invoke<Network.NetworkConfig>('generate_network_config', { tomlConfig }))
}
export const runNetworkInstance = (cfg: Network.NetworkConfig, save: boolean) => invoke('run_network_instance', { cfg: Network.toBackendNetworkConfig(cfg), save })
export const collectNetworkInfo = (instanceId: string) => invoke<Api.CollectNetworkInfoResponse>('collect_network_info', { instanceId })
export async function getVpnPortalInfo(instanceId: string) {
  const info = await invoke<Network.VpnPortalInfo | undefined>('get_vpn_portal_info', { instanceId })
  return info ? Network.normalizeVpnPortalInfo(info) : undefined
}
export const addVpnPortalClient = (instanceId: string, client: { name: string; virtual_ip: string; groups: string[] }) => invoke('patch_vpn_portal_clients', { instanceId, action: 'add', name: client.name, virtualIp: client.virtual_ip, groups: client.groups })
export const removeVpnPortalClient = (instanceId: string, name: string) => invoke('patch_vpn_portal_clients', { instanceId, action: 'remove', name })
export const clearVpnPortalClients = (instanceId: string) => invoke('patch_vpn_portal_clients', { instanceId, action: 'clear' })
export const setLoggingLevel = (level: string) => invoke('set_logging_level', { level })
export const setTunFd = (fd: number) => invoke('set_tun_fd', { fd })
export const getEasytierVersion = () => invoke<string>('easytier_version')
export const listNetworkInstanceIds = () => invoke<Api.ListNetworkInstanceIdResponse>('list_network_instance_ids')
export const deleteNetworkInstance = (instanceId: string) => invoke('remove_network_instance', { instanceId })
export const updateNetworkConfigState = (instanceId: string, disabled: boolean) => invoke('update_network_config_state', { instanceId, disabled })
export const saveNetworkConfig = (cfg: Network.NetworkConfig) => invoke('save_network_config', { cfg: Network.toBackendNetworkConfig(cfg) })
export const validateConfig = (cfg: Network.NetworkConfig) => invoke<Api.ValidateConfigResponse>('validate_config', { config: Network.toBackendNetworkConfig(cfg) })
export async function getConfig(instanceId: string) { return Network.normalizeNetworkConfig(await invoke<Network.NetworkConfig>('get_config', { instanceId })) }
export const sendConfigs = (enabledNetworks: string[]) => invoke('load_configs', {
  configs: loadStoredConfigs().map(({ config, source }) => ({ config: Network.toBackendNetworkConfig(config), source })),
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
