import { type as osType } from '@tauri-apps/plugin-os'
import * as Network from '../../../easytier-web/frontend-lib/src/types/network'
import * as Api from '../../../easytier-web/frontend-lib/src/modules/api'
import { StrToUuid } from '../../../easytier-web/frontend-lib/src/modules/utils'
import { loadStoredConfigs, saveLocalStoredConfig, removeLocalStoredConfig, loadEnabledNetworks, saveEnabledNetworks } from './storage'
import * as backend from './backend'
import { prepareVpnService, syncMobileVpnService } from './mobile_vpn'
import { normalizeGuiMetas, normalizeGuiRuntime } from './runtime'

export class GUIRemoteClient implements Api.RemoteClient {
  private savedRemoteConfigs = new Map<string, Network.NetworkConfig>()
  constructor(private readonly local?: { offline: () => boolean; changed: () => void; current?: () => boolean; runtimeAllowed?: () => boolean; remotePersistence?: () => boolean }) {}
  private get localOffline() { return this.local?.offline() === true }
  private assertCurrent() { if (this.local?.current?.() === false) throw new Error('configuration_context_changed') }
  private assertRuntime() { this.assertCurrent(); if (this.localOffline || this.local?.runtimeAllowed?.() === false) throw new Error('client_not_running') }
  private async assertUserLifecycle(id: string) {
    const meta = (await this.get_network_metas([id])).metas[id]
    this.assertRuntime()
    if (Api.isManagedNetwork(meta)) throw new Error('managed_lifecycle_owned_by_controller')
  }
  async get_network_interfaces(id?: string) {
    this.assertCurrent()
    const result = await backend.getNetworkInterfaces(id)
    this.assertCurrent()
    return result
  }
  async validate_config(config: Network.NetworkConfig): Promise<Api.ValidateConfigResponse> {
    this.assertCurrent()
    const result = this.localOffline ? { toml_config: await backend.parseNetworkConfig(config) } : await backend.validateConfig(config)
    this.assertCurrent()
    return result
  }
  async run_network(config: Network.NetworkConfig, save: boolean): Promise<undefined> {
    this.assertRuntime()
    if (osType() === 'android') await prepareVpnService(config.instance_id, config)
    try { this.assertRuntime(); await backend.runNetworkInstance(config, save); this.assertCurrent(); this.savedRemoteConfigs.delete(config.instance_id) }
    catch { if (osType() === 'android') await syncMobileVpnService().catch(() => undefined); throw new Error('network_start_failed') }
  }
  async get_network_info(id: string) { return normalizeGuiRuntime((await backend.collectNetworkInfo(id)).info?.map?.[id]) }
  async get_network_infos(): Promise<Record<string, Network.NetworkInstanceRunningInfo>> {
    this.assertCurrent()
    const result = await backend.collectNetworkInfo()
    this.assertCurrent()
    return Object.fromEntries(Object.entries(result.info?.map ?? {}).flatMap(([id, info]) => {
      const runtime = normalizeGuiRuntime(info)
      return runtime ? [[id, runtime]] : []
    }))
  }
  get_vpn_portal_info = backend.getVpnPortalInfo
  async add_vpn_portal_client(id: string, client: { name: string; virtual_ip: string; groups: string[] }): Promise<undefined> { await backend.addVpnPortalClient(id, client) }
  async remove_vpn_portal_client(id: string, name: string): Promise<undefined> { await backend.removeVpnPortalClient(id, name) }
  async clear_vpn_portal_clients(id: string): Promise<undefined> { await backend.clearVpnPortalClients(id) }
  async list_network_instance_ids(): Promise<Api.ListNetworkInstanceIdResponse> {
    this.assertCurrent()
    const result = this.localOffline ? { running_inst_ids: [], disabled_inst_ids: loadStoredConfigs().map(entry => StrToUuid(entry.config.instance_id)) } : await backend.listNetworkInstanceIds()
    this.assertCurrent()
    return result
  }
  async delete_network(id: string): Promise<undefined> {
    this.assertCurrent()
    if (!this.localOffline) { await backend.deleteNetworkInstance(id); this.assertCurrent(); this.savedRemoteConfigs.delete(id); return }
    removeLocalStoredConfig(id)
    saveEnabledNetworks(loadEnabledNetworks().filter(enabled => enabled !== id))
    this.local?.changed()
  }
  async update_network_instance_state(id: string, disabled: boolean): Promise<undefined> {
    this.assertRuntime()
    await this.assertUserLifecycle(id)
    let saved: Network.NetworkConfig | undefined
    if (!disabled && this.local?.remotePersistence?.()) {
      try { saved = await backend.getSavedRemoteConfig(id) }
      catch (error) {
        // A previously confirmed save must never be replaced with an older
        // live configuration merely because its durable read is unavailable.
        if (this.savedRemoteConfigs.has(id) || !backend.isRemotePersistenceUnsupported(error)) throw error
      }
    }
    if (!disabled && saved) { await this.run_network(saved, true); return }
    if (osType() === 'android' && !disabled) await prepareVpnService(id)
    try { this.assertRuntime(); await backend.updateNetworkConfigState(id, disabled); this.assertCurrent() }
    catch { if (osType() === 'android') await syncMobileVpnService().catch(() => undefined); throw new Error('network_state_update_failed') }
  }
  async save_config(config: Network.NetworkConfig): Promise<undefined> {
    this.assertCurrent()
    if (!this.localOffline) {
      if (this.local?.remotePersistence?.()) {
        const persisted = await backend.saveRemoteNetworkConfig(config)
        this.assertCurrent()
        this.savedRemoteConfigs.set(config.instance_id, persisted)
      } else { await backend.saveNetworkConfig(config); this.assertCurrent() }
      return
    }
    StrToUuid(config.instance_id)
    saveLocalStoredConfig(config)
    saveEnabledNetworks(loadEnabledNetworks().filter(enabled => enabled !== config.instance_id))
    this.local?.changed()
  }
  async get_network_config(id: string): Promise<Network.NetworkConfig> {
    this.assertCurrent()
    let config: Network.NetworkConfig | undefined
    if (this.localOffline) config = loadStoredConfigs().find(entry => entry.config.instance_id === id)?.config
    else if (this.local?.remotePersistence?.()) {
      // A pathless/old Core may still support edit-and-run. Reading its live
      // config does not make save-only persistence available or successful.
      try { config = await backend.getSavedRemoteConfig(id) }
      catch (error) {
        if (this.savedRemoteConfigs.has(id) || !backend.isRemotePersistenceUnsupported(error)) throw error
        config = await backend.getConfig(id)
      }
    } else config = await backend.getConfig(id)
    this.assertCurrent()
    if (!config) throw new Error('network_not_found')
    return config
  }
  async generate_config(config: Network.NetworkConfig): Promise<Api.GenerateConfigResponse> {
    try { this.assertCurrent(); const toml_config = await backend.parseNetworkConfig(config); this.assertCurrent(); return { toml_config } }
    catch { return { error: 'config_generation_failed' } }
  }
  async parse_config(toml: string): Promise<Api.ParseConfigResponse> {
    try { this.assertCurrent(); const config = await backend.generateNetworkConfig(toml); this.assertCurrent(); return { config } }
    catch { return { error: 'config_parse_failed' } }
  }
  async get_network_metas(ids: string[]): Promise<Api.GetNetworkMetasResponse> {
    this.assertCurrent()
    if (!this.localOffline) { const result = normalizeGuiMetas(await backend.getNetworkMetas(ids)); this.assertCurrent(); return result }
    return { metas: Object.fromEntries(loadStoredConfigs().filter(entry => ids.includes(entry.config.instance_id)).map(entry => [entry.config.instance_id, {
      network_name: entry.config.network_name || entry.config.instance_id, config_permission: entry.source === 'web' ? Api.ConfigFilePermission.READ_ONLY | Api.ConfigFilePermission.NO_DELETE : 0,
      source: entry.source === 'web' ? 2 : 1,
    }])) }
  }
}
