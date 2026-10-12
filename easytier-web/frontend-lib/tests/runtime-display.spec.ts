import { describe, expect, it } from 'vitest'
import { counter, CounterRate, formatQuantity, networkCidr, privateInterfaceAddress, privateIpv4Subnet, shellQuote, normalizeMetrics, normalizePeerConnStats, normalizeNetworkRuntime } from '../src/modules/runtimeDisplay'

describe('runtime counters and network candidates', () => {
  it('subtracts uint64 strings exactly before computing rates', () => {
    const sample = new CounterRate()
    expect(sample.sample('18446744073709551000', 1000, 'a')).toBeUndefined()
    expect(sample.sample('18446744073709551600', 3000, 'a')).toBe(300)
    expect(counter(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
    expect(counter('18446744073709551616')).toBeUndefined()
    expect(counter('not reported')).toBeUndefined()
    expect(formatQuantity('1024', true)).toBe('1 KiB')
    expect(formatQuantity(undefined)).toBe('—')
  })
  it('rebaselines reset counters, switched instances and missing samples', () => {
    const sample = new CounterRate()
    sample.sample(1000, 1000, 'a')
    expect(sample.sample(10, 2000, 'a')).toBeUndefined()
    expect(sample.sample(20, 4000, 'a')).toBe(5)
    expect(sample.sample(1000, 5000, 'b')).toBeUndefined()
    expect(sample.sample(undefined, 6000, 'b')).toBeUndefined()
    expect(sample.sample(2000, 7000, 'b')).toBeUndefined()
  })
  it('requires a true prefix and retains arbitrary IPv4/IPv6 masks', () => {
    expect(networkCidr('10.0.3.11')).toBeUndefined()
    expect(networkCidr('10.0.3.11/23')).toBe('10.0.2.0/23')
    expect(networkCidr('10.0.3.11/22')).toBe('10.0.0.0/22')
    expect(networkCidr('fd00:1:1::fffe/64')).toBe('fd00:1:1:0:0:0:0:0/64')
    expect(networkCidr('10.0.2.1/33')).toBeUndefined()
    expect(networkCidr('999.0.2.1/24')).toBeUndefined()
  })
  it('filters public, CGNAT, loopback, link-local and multicast candidates', () => {
    for (const addr of ['10.0.3.11', '172.16.1.1', '172.31.255.255', '192.168.1.1', 'fd00:1::1']) expect(privateInterfaceAddress(addr)).toBe(true)
    for (const addr of ['8.8.8.8', '100.64.1.1', '127.0.0.1', '169.254.1.1', '224.0.0.1', '172.32.1.1', 'fe80::1', '2001:db8::1']) expect(privateInterfaceAddress(addr)).toBe(false)
  })
  it('quotes command input without allowing shell substitution', () => {
    expect(shellQuote("a'b$(id)" )).toBe("'a'\\''b$(id)'")
  })
  it('decodes omitted metric zero only for an actually present named row', () => {
    const rows = normalizeMetrics([{ name: 'traffic_bytes_rx' }, { name: 'large', value: '18446744073709551615' }, {}])
    expect(rows).toHaveLength(2)
    expect(rows[0].value).toBe('0')
    expect(rows[1].value).toBe('18446744073709551615')
    expect(normalizeMetrics(undefined)).toEqual([])
  })
  it('decodes present peer statistics zero while preserving absent messages and exact uint64 strings', () => {
    expect(normalizePeerConnStats(undefined)).toBeUndefined()
    expect(normalizePeerConnStats(null)).toBeUndefined()
    expect(normalizePeerConnStats({})?.rx_bytes).toBe('0')
    expect(normalizePeerConnStats({ tx_bytes: '18446744073709551615' })?.tx_bytes).toBe('18446744073709551615')
    const info = normalizeNetworkRuntime({ peers: [{ peer_id: 1, conns: [{ stats: {} }, {}] }], peer_route_pairs: [{ route: {}, peer: { conns: [{ stats: {} }] } }] } as any)
    expect(info?.peers[0].conns[0].stats?.tx_bytes).toBe('0')
    expect(info?.peers[0].conns[1].stats).toBeUndefined()
    expect(info?.peer_route_pairs[0].peer?.conns[0].stats?.rx_bytes).toBe('0')
  })

  it('keeps auto LAN suggestions wholly inside RFC1918 without restricting manual CIDRs', () => {
    expect(privateIpv4Subnet('10.1.2.3', 7)).toBe(false)
    expect(privateIpv4Subnet('10.1.2.3', 8)).toBe(true)
    expect(privateIpv4Subnet('172.16.1.2', 11)).toBe(false)
    expect(privateIpv4Subnet('172.16.1.2', 12)).toBe(true)
    expect(privateIpv4Subnet('192.168.1.2', 15)).toBe(false)
    expect(privateIpv4Subnet('192.168.1.2', 16)).toBe(true)
    expect(privateIpv4Subnet('10.0.3.11', 23)).toBe(true)
    expect(privateIpv4Subnet('10.1.2.3', undefined)).toBe(false)
    expect(privateIpv4Subnet('8.8.8.8', 24)).toBe(false)
    expect(networkCidr('10.1.2.3/1')).toBe('0.0.0.0/1')
  })

})
