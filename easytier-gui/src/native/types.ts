export type * from '../../../easytier-web/frontend-lib/src/types/network'
export type * from '../../../easytier-web/frontend-lib/src/modules/api'

export type ConfigSource = 'user' | 'web' | 'legacy'
export interface ServiceOptions {
  config_dir: string
  rpc_portal: string
  file_log_level: string
  file_log_dir: string
  config_server?: string
}
export type ServiceStatus = 'Running' | 'Stopped' | 'NotInstalled'
interface ManagementConfiguration {
  config_server_url?: string
  config_server_needs_credentials?: boolean
}
export interface NormalMode extends ManagementConfiguration {
  mode: 'normal'
  rpc_portal?: string
  enable_rpc_port_listen?: boolean
  rpc_listen_port?: number
}
export interface ServiceMode extends ManagementConfiguration {
  mode: 'service'
  config_dir: string
  rpc_portal: string
  file_log_level: 'off' | 'warn' | 'info' | 'debug' | 'trace'
  file_log_dir: string
  installed_core_version?: string
}
export interface RemoteMode extends ManagementConfiguration {
  mode: 'remote'
  remote_rpc_address: string
}
export type Mode = NormalMode | ServiceMode | RemoteMode
export interface ConfigServerCredentials { address: string; token: string }
export type ManagementConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'authorized' | 'rejected' | 'pending_approval' | 'unknown'
export interface SessionSnapshot {
  platform: string
  version: string
  mode: Mode
  connected: boolean
  managementConnected: boolean
  managementState: ManagementConnectionState
  clientPaused: boolean
  serviceStatus: ServiceStatus
  busy: boolean
  errorCode?: string
  revision: number
}
