import { describe, expect, it } from 'vitest'
import { formatHistoryValue, historyPoints, historyStep, normalizeHostResources, percentage, sampleTimestamp, staleSample, usedMemory } from '../src/modules/observabilityDisplay'

describe('host resources and historical metrics', () => {
  it('preserves optional host fields and exact uint64 values without inventing old-Core zeroes', () => {
    expect(normalizeHostResources(undefined)).toBeUndefined()
    expect(normalizeHostResources(null)).toBeUndefined()
    const resources = normalizeHostResources({ sampled_at_unix_ms: '123', process_rss_bytes: '18446744073709551615', disks: [{ mount_point: '/', total_bytes: '1024' }], collection_errors: ['cpu', '/sensitive-path'] })
    expect(resources?.cpu_usage_percent).toBeUndefined()
    expect(resources?.memory_total_bytes).toBeUndefined()
    expect(resources?.process_rss_bytes).toBe('18446744073709551615')
    expect(resources?.disks?.[0].available_bytes).toBe('0')
    expect(resources?.collection_errors).toEqual(['cpu'])
  })
  it('calculates memory use with exact integers and rejects inconsistent or missing values', () => {
    expect(usedMemory('18446744073709551615', '18446744073709551614')?.used).toBe(1n)
    expect(usedMemory('8192', '2048')).toEqual({ total: 8192n, used: 6144n, percent: 75 })
    expect(usedMemory('8192', undefined)).toBeUndefined()
    expect(usedMemory('8192', '8193')).toBeUndefined()
    expect(usedMemory('0', '0')).toBeUndefined()
    expect(percentage(0)).toBe(0)
    expect(percentage(undefined)).toBeUndefined()
    expect(percentage(101)).toBeUndefined()
    expect(percentage(NaN)).toBeUndefined()
  })
  it('treats cached disk and host timestamps independently and rejects unsafe timestamps', () => {
    expect(sampleTimestamp('9007199254740992')).toBeUndefined()
    expect(staleSample('10000', 20000, 15000)).toBe(false)
    expect(staleSample('10000', 30000, 15000)).toBe(true)
    expect(staleSample('10000', 30000, 90000)).toBe(false)
    expect(staleSample(undefined, 20000, 15000)).toBe(true)
    expect(staleSample('1000000', 20000, 15000)).toBe(true)
  })
  it('keeps absent scrapes, invalid values and offline periods as line breaks', () => {
    expect(historyPoints([[130, 2048], [100, 1024], [115, null], [190, 3072], [205, 'NaN'], [220, -1]], 15)).toEqual([[100, 1024], [115, null], [130, 2048], [145, null], [190, 3072], [205, null], [220, null]])
    expect(historyPoints([[100, 1], [100, 0], ['115', 2]], 15)).toEqual([[100, 0]])
    expect(historyPoints(undefined, 15)).toEqual([])
  })
  it('bounds resolution, scales fractional rates and never displays unknown as zero', () => {
    expect(historyStep(3600, 15, 2000)).toBe(15)
    expect(historyStep(604800, 15, 2000)).toBe(303)
    expect(formatHistoryValue(1536.25, 'bytes_per_second')).toBe('1.5 KiB/s')
    expect(formatHistoryValue(0.5, 'bytes_per_second')).toBe('0.5 B/s')
    expect(formatHistoryValue(12.5, 'percent')).toBe('12.5%')
    expect(formatHistoryValue(null, 'bytes')).toBe('—')
    expect(formatHistoryValue(NaN, 'percent')).toBe('—')
  })
})
