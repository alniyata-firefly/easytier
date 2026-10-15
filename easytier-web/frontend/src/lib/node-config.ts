import { IPv4, IPv6 } from 'ip-num/IPNumber';
import { IPv4CidrRange, IPv6CidrRange } from 'ip-num/IPRange';

export type NodeConfigRecord = Record<string, unknown>;
export type NodeParameterIssue = { path: string; key: string; values?: Record<string, string | number> };
export const MAX_VPN_PORTAL_CLIENTS = 64;
export const UINT64_MAX = (1n << 64n) - 1n;
export const NODE_BOOLEAN_FLAGS = [
    'latency_first', 'use_smoltcp', 'disable_ipv6', 'ipv6_public_addr_auto',
    'enable_kcp_proxy', 'disable_kcp_input', 'enable_quic_proxy', 'disable_quic_input',
    'disable_p2p', 'p2p_only', 'lazy_p2p', 'bind_device', 'no_tun', 'enable_exit_node',
    'relay_all_peer_rpc', 'need_p2p', 'multi_thread', 'proxy_forward_by_system',
    'disable_encryption', 'disable_tcp_hole_punching', 'disable_udp_hole_punching',
    'enable_udp_broadcast_relay', 'disable_upnp', 'disable_sym_hole_punching',
    'enable_magic_dns', 'enable_private_mode',
] as const;

export function isConfigRecord(value: unknown): value is NodeConfigRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function applyNodePatch(current: NodeConfigRecord, patch: NodeConfigRecord): NodeConfigRecord {
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key]; else next[key] = value;
    }
    return next;
}

export function patchNodeRecord(current: unknown, patch: NodeConfigRecord): NodeConfigRecord {
    return applyNodePatch(isConfigRecord(current) ? current : {}, patch);
}

export function patchNodeRow(rows: unknown, index: number, patch: NodeConfigRecord): unknown[] {
    const next = Array.isArray(rows) ? [...rows] : [];
    next[index] = patchNodeRecord(next[index], patch);
    return next;
}

export function prepareNodeParametersForBackend(value: NodeConfigRecord): NodeConfigRecord {
    if (!Array.isArray(value.port_forwards)) return { ...value };
    const port_forwards = value.port_forwards.map(row => {
        if (!isConfigRecord(row)) return row;
        const next = { ...row };
        for (const key of ['bind_ip', 'dst_ip']) {
            const ip = next[key];
            if (typeof ip !== 'string' || !ip.includes(':') || ip.startsWith('[')) continue;
            try { IPv6.fromString(ip); next[key] = `[${ip}]`; } catch { /* Invalid drafts are rejected by validation. */ }
        }
        return next;
    });
    return { ...value, port_forwards };
}

export function nodeList(text: string): string[] {
    return [...new Set(text.split(/[\n,]+/).map(value => value.trim()).filter(Boolean))];
}

export function parseUint64Input(input: string): { valid: true; value?: string } | { valid: false } {
    const text = input.trim();
    if (!text) return { valid: true };
    if (!/^\d+$/.test(text)) return { valid: false };
    try {
        const value = BigInt(text);
        if (value > UINT64_MAX) return { valid: false };
        return value === 0n ? { valid: true } : { valid: true, value: value.toString() };
    } catch { return { valid: false }; }
}

export class NodeParameterValidationError extends Error {
    constructor(public readonly issue: NodeParameterIssue) { super(issue.key); this.name = 'NodeParameterValidationError'; }
}

const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const validIp = (value: unknown, ipv4Only = false): boolean => {
    if (typeof value !== 'string' || !value) return false;
    try { if (value.includes(':') && !ipv4Only) IPv6.fromString(value); else IPv4.fromString(value); return true; } catch { return false; }
};
const validCidr = (value: string, ipv4Only = false): boolean => {
    if (!/^[^/]+\/\d+$/.test(value)) return false;
    try { if (value.includes(':') && !ipv4Only) IPv6CidrRange.fromCidr(value); else IPv4CidrRange.fromCidr(value); return true; } catch { return false; }
};
const integerIn = (value: unknown, min: number, max: number): boolean => typeof value === 'number'
    && Number.isInteger(value) && value >= min && value <= max;
const transportProtocols = new Set(['tcp:', 'udp:', 'wg:', 'quic:', 'ws:', 'wss:', 'faketcp:']);
const validUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return transportProtocols.has(url.protocol) && !!url.hostname && !url.username && !url.password
            && (!url.port || integerIn(Number(url.port), 0, 65535));
    } catch { return false; }
};
const validSocket = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
    return !!match && validIp(match[1].replace(/^\[|\]$/g, '')) && integerIn(Number(match[2]), 0, 65535);
};

export function validateNodeParameters(value: NodeConfigRecord): NodeParameterIssue[] {
    const issues: NodeParameterIssue[] = [];
    const add = (path: string, key: string, values?: NodeParameterIssue['values']) => issues.push({ path, key, values });
    for (const key of [...NODE_BOOLEAN_FLAGS, 'prefer_ipv6', 'enable_relay_network_whitelist', 'enable_manual_routes', 'enable_socks5']) {
        if (present(value[key]) && typeof value[key] !== 'boolean') add(key, 'errors.boolean');
    }
    if (value.uplink !== undefined && value.uplink !== null) {
        const uplink = value.uplink;
        if (!isConfigRecord(uplink)) add('uplink', 'errors.object');
        else {
            const mode = uplink.mode ?? 'auto';
            if (mode !== 'auto' && mode !== 'manual' && mode !== '') add('uplink.mode', 'errors.uplinkMode');
            if (uplink.interfaces !== undefined && (!Array.isArray(uplink.interfaces) || uplink.interfaces.some(name => typeof name !== 'string'))) add('uplink.interfaces', 'errors.stringList');
            else {
                const names = (uplink.interfaces ?? []) as string[];
                if ((mode === 'manual' && names.length === 0) || ((mode === 'auto' || mode === '') && names.length > 0)
                    || names.some(name => !name || name.trim() !== name || /\p{Cc}/u.test(name)) || new Set(names).size !== names.length) add('uplink.interfaces', 'errors.uplinkInterfaces');
            }
        }
    }
    if (present(value.dev_name) && typeof value.dev_name !== 'string') add('dev_name', 'errors.text');
    if (present(value.mtu) && !integerIn(value.mtu, 400, 1380)) add('mtu', 'errors.range', { min: 400, max: 1380 });
    if (present(value.instance_recv_bps_limit)) {
        const limit = value.instance_recv_bps_limit;
        if ((typeof limit !== 'string' && typeof limit !== 'number')
            || (typeof limit === 'number' && (!Number.isSafeInteger(limit) || limit < 0))
            || !parseUint64Input(String(limit)).valid) add('instance_recv_bps_limit', 'errors.uint64');
    }
    const list = (key: string, validate?: (entry: string) => boolean, error = 'errors.text') => {
        if (value[key] === undefined || value[key] === null) return;
        if (!Array.isArray(value[key]) || (value[key] as unknown[]).some(entry => typeof entry !== 'string')) { add(key, 'errors.stringList'); return; }
        if (validate && (value[key] as string[]).some(entry => !validate(entry))) add(key, error);
    };
    list('listener_urls', validUrl, 'errors.listenerUrl');
    list('mapped_listeners', validUrl, 'errors.listenerUrl');
    list('proxy_cidrs', entry => {
        const parts = entry.split('->').map(part => part.trim());
        return parts.length <= 2 && parts.every(part => validCidr(part, true));
    }, 'errors.proxyCidr');
    list('relay_network_whitelist');
    list('routes', value.enable_manual_routes === true ? entry => validCidr(entry, true) : undefined, 'errors.ipv4Cidr');
    list('exit_nodes', entry => validIp(entry), 'errors.ip');
    if (value.enable_socks5 === true && !integerIn(value.socks5_port, 0, 65535)) add('socks5_port', 'errors.range', { min: 0, max: 65535 });
    if (value.port_forwards !== undefined && value.port_forwards !== null) {
        if (!Array.isArray(value.port_forwards)) add('port_forwards', 'errors.rows');
        else {
            value.port_forwards.forEach((row, index) => {
                const path = `port_forwards.${index}`;
                if (!isConfigRecord(row)) { add(path, 'errors.object'); return; }
                if (row.proto !== 'tcp' && row.proto !== 'udp') add(`${path}.proto`, 'errors.protocol');
                for (const key of ['bind_ip', 'dst_ip']) {
                    const ip = row[key];
                    if (typeof ip !== 'string' || !validIp(ip.replace(/^\[|\]$/g, ''))) add(`${path}.${key}`, 'errors.ip');
                }
                for (const key of ['bind_port', 'dst_port']) if (!integerIn(row[key], 1, 65535)) add(`${path}.${key}`, 'errors.range', { min: 1, max: 65535 });
            });
        }
    }
    if (value.vpn_portal_config !== undefined && value.vpn_portal_config !== null) {
        const portal = value.vpn_portal_config;
        if (!isConfigRecord(portal)) add('vpn_portal_config', 'errors.object');
        else {
            if (present(portal.enabled) && typeof portal.enabled !== 'boolean') add('vpn_portal_config.enabled', 'errors.boolean');
            if (!validSocket(portal.wireguard_listen)) add('vpn_portal_config.wireguard_listen', 'errors.socket');
            if (portal.clients !== undefined && !Array.isArray(portal.clients)) add('vpn_portal_config.clients', 'errors.rows');
            else if (Array.isArray(portal.clients)) {
                if (portal.clients.length > MAX_VPN_PORTAL_CLIENTS) add('vpn_portal_config.clients', 'errors.rowLimit', { max: MAX_VPN_PORTAL_CLIENTS });
                const names = new Set<string>(), addresses = new Set<string>();
                portal.clients.forEach((row, index) => {
                    const path = `vpn_portal_config.clients.${index}`;
                    if (!isConfigRecord(row)) { add(path, 'errors.object'); return; }
                    if (typeof row.name !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(row.name)) add(`${path}.name`, 'errors.clientName');
                    else if (names.has(row.name)) add(`${path}.name`, 'errors.duplicateName');
                    else names.add(row.name);
                    if (typeof row.virtual_ip !== 'string' || !validCidr(row.virtual_ip, true)) add(`${path}.virtual_ip`, 'errors.clientIp');
                    else {
                        const range = IPv4CidrRange.fromCidr(row.virtual_ip);
                        const ip = IPv4.fromString(row.virtual_ip.split('/')[0]);
                        const address = ip.toString();
                        if (ip.getValue() === range.getFirst().getValue() || ip.getValue() === range.getLast().getValue()) add(`${path}.virtual_ip`, 'errors.clientIp');
                        else if (addresses.has(address)) add(`${path}.virtual_ip`, 'errors.duplicateIp');
                        else addresses.add(address);
                    }
                    if (row.groups !== undefined && (!Array.isArray(row.groups) || row.groups.some(group => typeof group !== 'string'))) add(`${path}.groups`, 'errors.stringList');
                });
            }
        }
    }
    return issues;
}
