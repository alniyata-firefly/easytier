import { type } from '@tauri-apps/plugin-os';
import { buildConfigServerUrl, splitConfigServerUrl } from './config_server_credentials';

export interface ConfigServerCredentials {
    address: string
    token: string
}

export interface WebClientConfig {
    config_server_url?: string
    // Old username-only registrations must be replaced with a private server
    // address and a device management token, rather than reconnecting to the
    // official server implicitly.
    config_server_needs_credentials?: boolean
}

export interface NormalMode extends WebClientConfig {
    mode: 'normal'
    // if not provided will use ring tunnel rpc server
    rpc_portal?: string
    enable_rpc_port_listen?: boolean
    rpc_listen_port?: number
}

export interface ServiceMode extends WebClientConfig {
    mode: 'service'
    config_dir: string
    rpc_portal: string
    file_log_level: 'off' | 'warn' | 'info' | 'debug' | 'trace'
    file_log_dir: string
    installed_core_version?: string
}

export interface RemoteMode extends WebClientConfig {
    mode: 'remote'
    remote_rpc_address: string
}

export function saveMode(mode: Mode) {
    localStorage.setItem('app_mode', JSON.stringify(mode))
}


export function loadMode(): Mode {
    const modeStr = localStorage.getItem('app_mode')
    if (modeStr) {
        let mode = JSON.parse(modeStr) as Mode
        if (mode.config_server_url) {
            try {
                const credentials = splitConfigServerUrl(mode.config_server_url)
                if (credentials.legacy) {
                    mode.config_server_url = undefined
                    mode.config_server_needs_credentials = true
                } else {
                    mode.config_server_url = buildConfigServerUrl(credentials.address, credentials.token)
                }
            } catch {
                mode.config_server_url = undefined
                mode.config_server_needs_credentials = true
            }
        }
        if (type() === 'android') {
            return { ...mode, mode: 'normal' }
        }
        return mode
    } else {
        return { mode: 'normal' }
    }
}

export type Mode = NormalMode | ServiceMode | RemoteMode
