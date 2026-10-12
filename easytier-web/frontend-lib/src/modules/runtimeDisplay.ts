import { IPv4CidrRange, IPv6CidrRange } from 'ip-num'
import type { NetworkInstanceRunningInfo, PeerConnStats } from '../types/network'

export function counter(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return undefined
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return undefined
    if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined
    const n = BigInt(value)
    return n >= 0n && n <= 18446744073709551615n ? n : undefined
  } catch { return undefined }
}

export function formatQuantity(value: unknown, bytes = false): string {
  const n = counter(value)
  if (n === undefined) return '—'
  if (!bytes) return n.toLocaleString()
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
  let scale = 1n, unit = 0
  while (n >= scale * 1024n && unit < units.length - 1) { scale *= 1024n; unit++ }
  return `${Number(n * 100n / scale) / 100} ${units[unit]}`
}

/** Exact uint64 subtraction before conversion; first/reset/changed series have no rate. */
export class CounterRate {
  private previous?: { value: bigint; time: number; scope: string }
  reset() { this.previous = undefined }
  sample(value: unknown, time: number, scope = ''): number | undefined {
    const n = counter(value), old = this.previous
    if (n === undefined || !Number.isFinite(time)) { this.reset(); return undefined }
    this.previous = { value: n, time, scope }
    if (!old || old.scope !== scope || time <= old.time || n < old.value) return undefined
    return Number(n - old.value) / ((time - old.time) / 1000)
  }
}

/** Require a prefix: never infer /24 from an interface address. */
export function networkCidr(input: string): string | undefined {
  const text = input.trim()
  if (!/^[^/]+\/\d+$/.test(text)) return undefined
  try {
    if (text.includes(':')) {
      const range = IPv6CidrRange.fromCidr(text)
      return `${range.getFirst().toString()}/${range.getPrefix().toString()}`
    }
    const range = IPv4CidrRange.fromCidr(text)
    return `${range.getFirst().toString()}/${range.getPrefix().toString()}`
  } catch { return undefined }
}

export function privateInterfaceAddress(address: string): boolean {
  if (address.includes(':')) return /^(?:fc|fd)[0-9a-f]{2}:/i.test(address)
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n < 256)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168))
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true } } catch { /* HTTP fallback below */ }
  const area = document.createElement('textarea')
  const focus = document.activeElement as HTMLElement | null
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'
  document.body.appendChild(area); area.select()
  try { return document.execCommand('copy') } catch { return false }
  finally { area.remove(); focus?.focus() }
}

export function endpointFamily(url: string | undefined): string {
  if (!url) return ''
  try {
    const host = new URL(url).hostname
    if (host.startsWith('[') && host.endsWith(']')) return 'IPv6'
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'IPv4'
  } catch { /* Unknown endpoint format */ }
  return ''
}


/** Proto3 non-optional scalar fields may be omitted when their true value is zero. */
export function normalizeMetrics(rows: unknown): Array<{ name: string; value?: number | string; labels?: Record<string, string> }> {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row && typeof row.name === 'string' && row.name.length > 0).map(row => ({
    ...row,
    value: row.value === undefined ? '0' : row.value,
  }))
}

export function normalizePeerConnStats(stats: unknown): PeerConnStats | undefined {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return undefined
  const record = stats as Record<string, unknown>
  const value = (name: string): number | string => record[name] === undefined ? '0'
    : typeof record[name] === 'number' || typeof record[name] === 'string' ? record[name] as number | string : ''
  return { ...record, rx_bytes: value('rx_bytes'), tx_bytes: value('tx_bytes'),
    rx_packets: value('rx_packets'), tx_packets: value('tx_packets'), latency_us: value('latency_us') }
}

export function normalizePeerInfos<T extends { conns: Array<{ stats?: unknown }> }>(peers: T[]): T[] {
  return peers.map(peer => ({ ...peer, conns: (peer.conns ?? []).map(conn => ({
    ...conn, stats: normalizePeerConnStats(conn.stats),
  })) })) as T[]
}

export function normalizeNetworkRuntime(info: NetworkInstanceRunningInfo | undefined): NetworkInstanceRunningInfo | undefined {
  if (!info) return undefined
  return { ...info, peers: normalizePeerInfos(info.peers ?? []),
    peer_route_pairs: (info.peer_route_pairs ?? []).map(pair => ({ ...pair,
      peer: pair.peer ? normalizePeerInfos([pair.peer])[0] : undefined,
    })) }
}


/** Auto-discovered IPv4 LANs must remain wholly inside their RFC1918 range. */
export function privateIpv4Subnet(address: string, prefix: number | undefined): boolean {
  if (address.includes(':') || !privateInterfaceAddress(address) || !Number.isInteger(prefix)) return false
  const first = Number(address.split('.')[0])
  const minimum = first === 10 ? 8 : first === 172 ? 12 : 16
  return prefix! >= minimum && prefix! <= 32
}
