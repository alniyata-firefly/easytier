import { type as osType } from '@tauri-apps/plugin-os'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import type * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import * as backend from './backend'
import { prepareVpnService, syncMobileVpnService } from './mobile_vpn'

export class GUIRemoteClient implements Api.RemoteClient {
  validate_config = backend.validateConfig
  async run_network(config: Network.NetworkConfig, save: boolean): Promise<undefined> {
    if (osType() === 'android') await prepareVpnService(config.instance_id, config)
    try { await backend.runNetworkInstance(config, save) }
    catch { if (osType() === 'android') await syncMobileVpnService().catch(() => undefined); throw new Error('network_start_failed') }
  }
  async get_network_info(id: string) { return (await backend.collectNetworkInfo(id)).info?.map?.[id] }
  get_vpn_portal_info = backend.getVpnPortalInfo
  async add_vpn_portal_client(id: string, client: { name: string; virtual_ip: string; groups: string[] }): Promise<undefined> { await backend.addVpnPortalClient(id, client) }
  async remove_vpn_portal_client(id: string, name: string): Promise<undefined> { await backend.removeVpnPortalClient(id, name) }
  async clear_vpn_portal_clients(id: string): Promise<undefined> { await backend.clearVpnPortalClients(id) }
  list_network_instance_ids = backend.listNetworkInstanceIds
  async delete_network(id: string): Promise<undefined> { await backend.deleteNetworkInstance(id) }
  async update_network_instance_state(id: string, disabled: boolean): Promise<undefined> {
    if (osType() === 'android' && !disabled) await prepareVpnService(id)
    try { await backend.updateNetworkConfigState(id, disabled) }
    catch { if (osType() === 'android') await syncMobileVpnService().catch(() => undefined); throw new Error('network_state_update_failed') }
  }
  async save_config(config: Network.NetworkConfig): Promise<undefined> { await backend.saveNetworkConfig(config) }
  get_network_config = backend.getConfig
  async generate_config(config: Network.NetworkConfig): Promise<Api.GenerateConfigResponse> {
    try { return { toml_config: await backend.parseNetworkConfig(config) } }
    catch { return { error: 'config_generation_failed' } }
  }
  async parse_config(toml: string): Promise<Api.ParseConfigResponse> {
    try { return { config: await backend.generateNetworkConfig(toml) } }
    catch { return { error: 'config_parse_failed' } }
  }
  get_network_metas = backend.getNetworkMetas
}
