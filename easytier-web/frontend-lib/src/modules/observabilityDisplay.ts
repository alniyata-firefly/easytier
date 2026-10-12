import { counter } from './runtimeDisplay'

export interface HostDiskResources { mount_point: string; total_bytes?: number | string; available_bytes?: number | string }
export interface HostResources {
  sampled_at_unix_ms?: number | string
  cpu_usage_percent?: number
  memory_total_bytes?: number | string
  memory_available_bytes?: number | string
  process_rss_bytes?: number | string
  disks?: HostDiskResources[]
  disks_sampled_at_unix_ms?: number | string
  collection_errors?: string[]
}

/** Optional protobuf fields stay unknown; only a present disk message can contain omitted zero. */
export function normalizeHostResources(value: unknown): HostResources | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as HostResources
  return { ...row, disks: Array.isArray(row.disks) ? row.disks.filter(disk => disk && typeof disk.mount_point === 'string').map(disk => ({
    ...disk, total_bytes: disk.total_bytes === undefined ? '0' : disk.total_bytes,
    available_bytes: disk.available_bytes === undefined ? '0' : disk.available_bytes,
  })) : [], collection_errors: Array.isArray(row.collection_errors) ? row.collection_errors.filter(key => ['cpu', 'memory', 'process_rss', 'disks'].includes(key)) : [] }
}

export function usedMemory(totalValue: unknown, availableValue: unknown): { used: bigint; total: bigint; percent: number } | undefined {
  const total = counter(totalValue), available = counter(availableValue)
  if (total === undefined || available === undefined || total === 0n || available > total) return undefined
  const used = total - available
  return { used, total, percent: Number(used * 10000n / total) / 100 }
}

export function percentage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
}

export function sampleTimestamp(value: unknown): number | undefined {
  const n = counter(value)
  return n !== undefined && n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : undefined
}

export function staleSample(value: unknown, now: number, maxAgeMs: number): boolean {
  const time = sampleTimestamp(value)
  return time === undefined || now - time > maxAgeMs || time - now > 60000
}

export type HistoryPoint = [number, number | null]
export interface HistorySeries { labels: Record<string, string>; values: HistoryPoint[] }

/** Missing/invalid data remains a gap, including absent scrapes between otherwise valid points. */
export function historyPoints(values: unknown, step: number): HistoryPoint[] {
  if (!Array.isArray(values)) return []
  const unique = new Map<number, number | null>()
  for (const point of values) {
    if (!Array.isArray(point) || typeof point[0] !== 'number' || !Number.isFinite(point[0])) continue
    const value = point[1]
    unique.set(point[0], typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
  }
  const sorted = [...unique].sort((a, b) => a[0] - b[0]), result: HistoryPoint[] = []
  for (const point of sorted) {
    const previous = result[result.length - 1]
    if (previous && step > 0 && point[0] - previous[0] > step * 1.5) result.push([previous[0] + step, null])
    result.push(point)
  }
  return result
}

export function historyStep(rangeSeconds: number, minStep: number, maxPoints: number): number {
  return Math.max(1, Math.ceil(minStep), Math.ceil(rangeSeconds / Math.max(1, maxPoints - 1)))
}

export function formatHistoryValue(value: number | null | undefined, unit: string): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—'
  if (unit === 'percent') return `${Math.round(value * 100) / 100}%`
  if (unit === 'bytes' || unit === 'bytes_per_second') {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
    let amount = value, index = 0
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++ }
    return `${Number(amount.toFixed(2))} ${units[index]}${unit === 'bytes_per_second' ? '/s' : ''}`
  }
  return `${Math.round(value * 100) / 100}${unit.endsWith('_per_second') ? '/s' : ''}`
}
