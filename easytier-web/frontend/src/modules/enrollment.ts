import { RuntimeDisplay } from 'easytier-frontend-lib';
import type { ConsoleInfo } from './api';
import { getApiBase } from './api-host';

export function enrollmentCommand(info: ConsoleInfo, token: string): string {
    if (!token) return '';
    const api = new URL(getApiBase() || '.', window.location.href);
    const fallback = `${info.config_server_protocol}://${api.hostname}:${info.config_server_port}/`;
    const endpoint = new URL(info.advertised_config_server_url || fallback);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/${encodeURIComponent(token)}`;
    return `easytier-core --config-server ${RuntimeDisplay.shellQuote(endpoint.href)}`;
}
