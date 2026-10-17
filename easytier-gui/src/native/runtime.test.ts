import { describe, expect, it } from 'vitest'
import { NetworkInstanceRunningInfo as RuntimePb, NetworkMeta as MetaPb } from '../../../easytier-web/frontend-lib/src/generated/proto/api_manage'
import type { NetworkInstanceRunningInfo } from '../../../easytier-web/frontend-lib/src/types/network'
import type { GetNetworkMetasResponse } from '../../../easytier-web/frontend-lib/src/modules/api'
import { NatType } from '../../../easytier-web/frontend-lib/src/types/network'
import { lossRate } from '../../../easytier-web/frontend-lib/src/modules/statusDisplay'
import { normalizeGuiMetas, normalizeGuiRuntime } from './runtime'

describe('GUI metadata protobuf JSON boundary', () => {
  it('restores legal zero permissions omitted by the actual protobuf JSON serializer', () => {
    const meta = MetaPb.toJson(MetaPb.create({ network_name: 'User network', config_permission: 0 }), { useProtoFieldName: true })
    const response = { metas: { user: meta } } as unknown as GetNetworkMetasResponse
    expect(response.metas.user.config_permission).toBeUndefined()
    expect(normalizeGuiMetas(response).metas.user.config_permission).toBe(0)
    expect(response.metas.user.config_permission).toBeUndefined()
  })

  it('preserves each explicit permission bitset and other metadata fields', () => {
    const response = { metas: Object.fromEntries([0, 1, 2, 3].map(permission => [String(permission), {
      network_name: 'Explicit flags', config_permission: permission, source: 'Web',
    }])) }
    expect(normalizeGuiMetas(response)).toEqual(response)
  })

  it('does not invent a permissive message when metadata is absent', () => {
    expect(normalizeGuiMetas(undefined)).toEqual({ metas: {} })
    expect(normalizeGuiMetas({} as GetNetworkMetasResponse)).toEqual({ metas: {} })
    const response = { metas: { missing: undefined, null: null } } as unknown as GetNetworkMetasResponse
    expect(normalizeGuiMetas(response)).toEqual({ metas: {} })
  })
})

// Match Rust pbjson's proto field names and omitted default/repeated values.
function wire(input: Parameters<typeof RuntimePb.fromJson>[0]): NetworkInstanceRunningInfo {
  return RuntimePb.toJson(RuntimePb.fromJson(input), { useProtoFieldName: true }) as unknown as NetworkInstanceRunningInfo
}

describe('GUI runtime protobuf JSON boundary', () => {
  it('excludes closed connection snapshots from both peer and route-pair UI details', () => {
    const peer = { peer_id: 6, conns: [{ conn_id: 'closed', is_closed: true }, { conn_id: 'open' }] }
    const input = wire({ peers: [peer], peer_route_pairs: [{ route: { peer_id: 6 }, peer }] })
    const output = normalizeGuiRuntime(input)!
    expect(output.peers[0].conns.map(conn => conn.conn_id)).toEqual(['open'])
    expect(output.peer_route_pairs[0].peer?.conns.map(conn => conn.conn_id)).toEqual(['open'])
    expect(input.peers[0].conns).toHaveLength(2)
  })
  it('decodes actual protobuf enum-name JSON so NAT labels display names instead of ordinals', () => {
    const input = wire({ my_node_info: { stun_info: { udp_nat_type: 'FullCone', tcp_nat_type: 'Symmetric' } } })
    expect(input.my_node_info.stun_info.udp_nat_type).toBe('FullCone')
    const stun = normalizeGuiRuntime(input)!.my_node_info.stun_info
    expect(stun.udp_nat_type).toBe(NatType.FullCone)
    expect(stun.tcp_nat_type).toBe(NatType.Symmetric)
    expect(NatType[stun.udp_nat_type]).toBe('FullCone')
    expect(NatType[stun.tcp_nat_type]).toBe('Symmetric')
  })

  it('retains numeric NAT codes and restores enum zero only for an existing STUN message', () => {
    const input = { my_node_info: { stun_info: { udp_nat_type: NatType.FullCone, tcp_nat_type: NatType.Symmetric } } } as NetworkInstanceRunningInfo
    expect(normalizeGuiRuntime(input)?.my_node_info.stun_info).toEqual(input.my_node_info.stun_info)
    const empty = normalizeGuiRuntime(wire({ my_node_info: { stun_info: {} } }))!
    expect(empty.my_node_info.stun_info).toMatchObject({ udp_nat_type: NatType.Unknown, tcp_nat_type: NatType.Unknown })
    expect(normalizeGuiRuntime(wire({ my_node_info: {} }))?.my_node_info.stun_info).toBeUndefined()
  })

  it('restores omitted non-optional zero loss without inventing peers or absent counter stats', () => {
    const input = wire({ peers: [{ peer_id: 6, conns: [{ conn_id: 'zero-loss' }] }],
      peer_route_pairs: [{ route: { peer_id: 6 }, peer: { peer_id: 6, conns: [{ conn_id: 'zero-loss' }] } }] })
    expect(input.peers[0].conns[0].loss_rate).toBeUndefined()
    const output = normalizeGuiRuntime(input)!
    expect(output.peers[0].conns[0].loss_rate).toBe(0)
    expect(output.peers[0].conns[0].stats).toBeUndefined()
    expect(lossRate(output.peer_route_pairs[0])).toBe('0%')
    expect(lossRate({ route: output.peer_route_pairs[0].route })).toBe('')
  })

  it('restores omitted repeated fields while keeping optional node information absent', () => {
    const input = wire({ running: true })
    expect(input.routes).toBeUndefined()
    expect(normalizeGuiRuntime(input)).toMatchObject({ running: true, routes: [], peers: [], peer_route_pairs: [], events: [] })
    expect(normalizeGuiRuntime(input)?.my_node_info).toBeUndefined()
    expect(normalizeGuiRuntime(undefined)).toBeUndefined()
  })

  it('retains every route and real prefix when empty proxy_cidrs is omitted', () => {
    const input = wire({ running: true, routes: [
      { peer_id: 2, hostname: 'no subnet', next_hop_peer_id: 2, cost: 1 },
      { peer_id: 3, hostname: 'subnet gateway', next_hop_peer_id: 2, cost: 2,
        ipv4_addr: { address: { addr: 174325763 }, network_length: 24 },
        ipv6_addr: { address: { part1: 0xfd000001 }, network_length: 64 },
        proxy_cidrs: ['10.50.0.0/24', 'fd00:50::/64'],
        next_hop_peer_id_latency_first: 8, cost_latency_first: 3 },
    ] })
    expect(input.routes[0].proxy_cidrs).toBeUndefined()
    const output = normalizeGuiRuntime(input)!
    expect(output.routes).toHaveLength(2)
    expect(output.routes[0].proxy_cidrs).toEqual([])
    expect(output.routes[1]).toMatchObject(input.routes[1])
    expect(output.routes[1].proxy_cidrs).toEqual(['10.50.0.0/24', 'fd00:50::/64'])
    expect(output.routes[0]).toMatchObject({ ipv4_addr: null, hostname: 'no subnet', peer_id: 2 })
    expect(input.routes[0].proxy_cidrs).toBeUndefined()
  })

  it('restores omitted route zero scalars without fabricating an IPv4 address or next-hop node', () => {
    const input = wire({ routes: [{ peer_id: 4 }] })
    expect(normalizeGuiRuntime(input)?.routes[0]).toMatchObject({ peer_id: 4,
      hostname: '', version: '', cost: 0, next_hop_peer_id: 0, proxy_cidrs: [], ipv4_addr: null })
  })

  it('handles optional pair routes, peers, connections, stats, tunnel and node messages', () => {
    const input = wire({ my_node_info: {}, peers: [{ peer_id: 2 }, { peer_id: 3, conns: [
      { conn_id: 'no stats' }, { conn_id: 'zero counters', stats: {} },
    ] }], peer_route_pairs: [{}, { route: { peer_id: 2 } }, { route: { peer_id: 3 }, peer: { peer_id: 3 } }] })
    const output = normalizeGuiRuntime(input)!
    expect(output.my_node_info.listeners).toEqual([])
    expect(output.peers[0].conns).toEqual([])
    expect(output.peers[1].conns[0]).toMatchObject({ conn_id: 'no stats', features: [] })
    expect(output.peers[1].conns[0].stats).toBeUndefined()
    expect(output.peers[1].conns[0].tunnel).toBeUndefined()
    expect(output.peers[1].conns[1].stats).toMatchObject({ rx_bytes: '0', tx_bytes: '0' })
    expect(output.peer_route_pairs).toHaveLength(2)
    expect(output.peer_route_pairs[0].peer).toBeUndefined()
    expect(output.peer_route_pairs[1].peer?.conns).toEqual([])
  })

  it('keeps uint64 counter precision and legacy string IPv4 records intact', () => {
    const input = wire({ peers: [{ peer_id: 1, conns: [{ conn_id: 'large', stats: { rx_bytes: '9007199254740993' } }] }] })
    input.routes = [{ peer_id: 2, ipv4_addr: '10.100.0.3/24' }] as NetworkInstanceRunningInfo['routes']
    const output = normalizeGuiRuntime(input)!
    expect(output.peers[0].conns[0].stats?.rx_bytes).toBe('9007199254740993')
    expect(output.routes[0].ipv4_addr).toBe('10.100.0.3/24')
  })
})
