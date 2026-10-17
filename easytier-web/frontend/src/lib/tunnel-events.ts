export const tunnelEventKinds = ['Connecting', 'ConnectError', 'ConnectionAccepted', 'ConnectionError', 'PeerAdded', 'PeerRemoved', 'PeerConnAdded', 'PeerConnRemoved'] as const;
export type TunnelEventKind = typeof tunnelEventKinds[number];
export const tunnelFailureReasons = ['timeout', 'refused', 'unreachable', 'name_resolution', 'reset', 'closed', 'permission', 'authentication', 'cancelled', 'unknown'] as const;
export type TunnelFailureReason = typeof tunnelFailureReasons[number];
export interface TunnelEvent {
    id: string;
    kind: TunnelEventKind;
    occurredAt?: number;
    peerId?: number;
    protocol?: string;
    ipVersion?: 'IPv4' | 'IPv6';
    localEndpoint?: string;
    remoteEndpoint?: string;
    failureReason?: TunnelFailureReason;
}

const kinds = new Set<string>(tunnelEventKinds);
const protocols = new Set(['udp', 'tcp', 'faketcp', 'ws', 'wss', 'quic', 'ring', 'unix', 'wg', 'kcp', 'icmp', 'http', 'https', 'txt', 'srv']);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const field = (value: Record<string, unknown> | undefined, snake: string, camel: string) => value?.[snake] ?? value?.[camel];
const peerId = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : undefined;
const protocol = (value: unknown) => typeof value === 'string' && protocols.has(value.toLowerCase()) ? value.toLowerCase().toUpperCase() : undefined;

/** Endpoints deliberately omit paths as well as userinfo, query and fragment:
 * manual connection URLs may carry credentials in any of those components. */
export function safeTunnelEndpoint(value: unknown): { endpoint: string; protocol: string } | undefined {
    const input = typeof value === 'string' ? value : object(value)?.url;
    if (typeof input !== 'string' || input.length > 4096) return undefined;
    try {
        const url = new URL(input);
        const type = protocol(url.protocol.slice(0, -1));
        if (!type || !url.hostname || url.hostname.length > 253) return undefined;
        return { endpoint: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`, protocol: type };
    } catch { return undefined; }
}

/** Only fixed categories leave this function; raw errors may contain secrets. */
export function classifyTunnelFailure(value: unknown): TunnelFailureReason {
    if (typeof value !== 'string') return 'unknown';
    const error = value.slice(0, 16384).toLowerCase();
    if (/timed?\s*out|timeout|deadline.*(?:elapsed|exceeded)|os error (?:110|60|10060)\b/.test(error)) return 'timeout';
    if (/connection refused|os error (?:111|61|10061)\b/.test(error)) return 'refused';
    if (/(?:network|host) is unreachable|no route to host|os error (?:101|113|10051|10065)\b/.test(error)) return 'unreachable';
    if (/name resolution|failed to (?:look\s*up|resolve)|dns (?:error|failed)|nodename nor servname/.test(error)) return 'name_resolution';
    if (/connection reset|os error (?:104|54|10054)\b/.test(error)) return 'reset';
    if (/connection closed|unexpected eof|broken pipe/.test(error)) return 'closed';
    if (/permission denied|operation not permitted|os error (?:1|13|10013)\b/.test(error)) return 'permission';
    if (/authentication|unauthorized|handshake (?:failed|failure)|invalid (?:credential|password)|network (?:name|secret) mismatch/.test(error)) return 'authentication';
    if (/cancelled|canceled|request aborted/.test(error)) return 'cancelled';
    return 'unknown';
}

function tuple(value: unknown, size: number): string[] | undefined {
    return Array.isArray(value) && value.length === size && value.every(item => typeof item === 'string') ? value as string[] : undefined;
}

/** Parse the Core EventJournal envelope, retaining no raw JSON or payload.
 * The journal window is twenty events total, including non-connection events. */
export function parseTunnelEvents(input: unknown): TunnelEvent[] {
    if (!Array.isArray(input)) return [];
    return input.slice(0, 20).flatMap((raw, index): TunnelEvent[] => {
        if (typeof raw !== 'string' || raw.length > 65536) return [];
        let envelope: Record<string, unknown> | undefined;
        try { envelope = object(JSON.parse(raw)); } catch { return []; }
        const tagged = object(envelope?.event);
        const keys = Object.keys(tagged ?? {});
        if (keys.length !== 1 || !kinds.has(keys[0])) return [];
        const kind = keys[0] as TunnelEventKind, payload = tagged![kind];
        const time = envelope?.time;
        const parsedTime = typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(time) ? Date.parse(time) : NaN;
        const result: TunnelEvent = { id: `${index}:${kind}`, kind, ...(Number.isFinite(parsedTime) ? { occurredAt: parsedTime } : {}) };
        if (kind === 'PeerAdded' || kind === 'PeerRemoved') {
            const id = peerId(payload); if (id === undefined) return [];
            result.peerId = id;
        } else if (kind === 'PeerConnAdded' || kind === 'PeerConnRemoved') {
            const connection = object(payload); if (!connection) return [];
            result.peerId = peerId(field(connection, 'peer_id', 'peerId'));
            const tunnel = object(connection.tunnel);
            const local = safeTunnelEndpoint(field(tunnel, 'local_addr', 'localAddr'));
            const remote = safeTunnelEndpoint(field(tunnel, 'remote_addr', 'remoteAddr')) ?? safeTunnelEndpoint(field(tunnel, 'resolved_remote_addr', 'resolvedRemoteAddr'));
            result.protocol = protocol(field(tunnel, 'tunnel_type', 'tunnelType')) ?? remote?.protocol ?? local?.protocol;
            result.localEndpoint = local?.endpoint; result.remoteEndpoint = remote?.endpoint;
        } else if (kind === 'Connecting') {
            if (typeof payload !== 'string') return [];
            const remote = safeTunnelEndpoint(payload);
            result.remoteEndpoint = remote?.endpoint; result.protocol = remote?.protocol;
        } else {
            const values = tuple(payload, kind === 'ConnectionAccepted' ? 2 : 3); if (!values) return [];
            if (kind === 'ConnectError') {
                const remote = safeTunnelEndpoint(values[0]);
                result.remoteEndpoint = remote?.endpoint; result.protocol = remote?.protocol;
                result.ipVersion = /^(?:V4|IPv4)$/i.test(values[1]) ? 'IPv4' : /^(?:V6|IPv6)$/i.test(values[1]) ? 'IPv6' : undefined;
                result.failureReason = classifyTunnelFailure(values[2]);
            } else {
                const local = safeTunnelEndpoint(values[0]), remote = safeTunnelEndpoint(values[1]);
                result.localEndpoint = local?.endpoint; result.remoteEndpoint = remote?.endpoint;
                result.protocol = remote?.protocol ?? local?.protocol;
                if (kind === 'ConnectionError') result.failureReason = classifyTunnelFailure(values[2]);
            }
        }
        return [result];
    });
}

export function tunnelEventState(kind: TunnelEventKind): string {
    if (kind === 'ConnectError' || kind === 'ConnectionError') return 'failed';
    if (kind === 'Connecting') return 'connecting';
    if (kind === 'PeerConnAdded' || kind === 'PeerAdded') return 'online';
    if (kind === 'PeerConnRemoved' || kind === 'PeerRemoved') return 'offline';
    return 'running';
}
