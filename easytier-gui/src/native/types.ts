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
export const VPN_FAILURE_CODES = [
  'vpn_permission_denied', 'vpn_permission_revoked', 'vpn_tun_fd_failed', 'vpn_foreground_start_failed',
  'vpn_tun_start_failed', 'vpn_service_busy', 'vpn_start_timeout', 'vpn_stop_timeout',
  'vpn_stop_status_unavailable', 'vpn_stop_failed', 'vpn_instance_failed', 'vpn_no_network',
  'vpn_start_failed', 'vpn_connection_timeout', 'vpn_listener_failed',
  'vpn_core_install_timeout', 'vpn_core_install_failed', 'vpn_core_cleanup_pending', 'vpn_core_cleanup_failed',
  'vpn_core_status_timeout', 'vpn_tun_descriptor_unavailable', 'vpn_core_instance_replaced',
  'vpn_core_unavailable', 'vpn_tun_request_stale',
] as const
export type VpnFailureCode = typeof VPN_FAILURE_CODES[number]
export function normalizeVpnFailureCode(value: unknown): VpnFailureCode | undefined {
  return typeof value === 'string' && (VPN_FAILURE_CODES as readonly string[]).includes(value)
    ? value as VpnFailureCode : undefined
}
export interface SessionSnapshot {
  platform: string
  version: string
  mode: Mode
  connected: boolean
  managementConnected: boolean
  managementState: ManagementConnectionState
  clientPaused: boolean
  vpnConnected: boolean
  vpnTransition?: 'connecting' | 'disconnecting'
  vpnStopIncomplete?: boolean
  vpnFailureCode?: VpnFailureCode
  serviceStatus: ServiceStatus
  busy: boolean
  errorCode?: string
  revision: number
}
