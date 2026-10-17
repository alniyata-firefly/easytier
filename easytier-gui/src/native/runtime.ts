import type { NetworkInstanceRunningInfo, PeerInfo, Route } from '../../../easytier-web/frontend-lib/src/types/network'
import { normalizePeerInfos } from '../../../easytier-web/frontend-lib/src/modules/runtimeDisplay'
import type { GetNetworkMetasResponse } from '../../../easytier-web/frontend-lib/src/modules/api'
import { NatType } from '../../../easytier-web/frontend-lib/src/types/network'

function normalizeNatType(value: unknown): NatType {
  if (typeof value === 'number' && typeof NatType[value] === 'string') return value
  const code = typeof value === 'string' ? NatType[value as keyof typeof NatType] : undefined
  return typeof code === 'number' ? code : NatType.Unknown
}

/** NetworkMeta permission zero is a valid proto3 default, not absent metadata. */
export function normalizeGuiMetas(response: GetNetworkMetasResponse | undefined): GetNetworkMetasResponse {
  return { metas: Object.fromEntries(Object.entries(response?.metas ?? {}).flatMap(([id, meta]) => {
    // Retain the App's fail-closed fallback if the entire message is missing.
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
    return [[id, { ...meta, network_name: meta.network_name ?? '', config_permission: meta.config_permission ?? 0 }]]
  })) }
}

function normalizeRoute(route: Route): Route {
  // api.instance.Route uses proto3 scalars and repeated fields. Rust pbjson
  // omits their empty/default values; a route without proxy CIDRs is valid.
  return { ...route, peer_id: route.peer_id ?? 0, ipv4_addr: route.ipv4_addr ?? null,
    next_hop_peer_id: route.next_hop_peer_id ?? 0, cost: route.cost ?? 0,
    proxy_cidrs: route.proxy_cidrs ?? [], hostname: route.hostname ?? '',
    inst_id: route.inst_id ?? '', version: route.version ?? '' }
}

function normalizePeers(peers: PeerInfo[] | undefined): PeerInfo[] {
  return normalizePeerInfos(peers ?? []).map(peer => ({ ...peer,
    conns: peer.conns.filter(conn => !conn.is_closed).map(conn => ({ ...conn, features: conn.features ?? [], loss_rate: conn.loss_rate ?? 0 })),
  }))
}

/** Restore protobuf defaults once at the GUI IPC boundary, without inventing
 * optional messages or discarding a route's IPv6, feature, or latency fields. */
export function normalizeGuiRuntime(info: NetworkInstanceRunningInfo | undefined): NetworkInstanceRunningInfo | undefined {
  if (!info) return undefined
  const node = info.my_node_info
  return { ...info, dev_name: info.dev_name ?? '', running: info.running ?? false,
    my_node_info: node ? { ...node, listeners: node.listeners ?? [],
      stun_info: node.stun_info ? { ...node.stun_info,
        udp_nat_type: normalizeNatType(node.stun_info.udp_nat_type),
        tcp_nat_type: normalizeNatType(node.stun_info.tcp_nat_type),
      } : node.stun_info,
    } : node,
    events: info.events ?? [], routes: (info.routes ?? []).map(normalizeRoute),
    peers: normalizePeers(info.peers),
    // The route message is optional in api.instance.PeerRoutePair. A missing
    // pair route has no row to display; standalone peers are retained above.
    peer_route_pairs: (info.peer_route_pairs ?? []).filter(pair => pair.route != null).map(pair => ({
      ...pair, route: normalizeRoute(pair.route),
      peer: pair.peer ? normalizePeers([pair.peer])[0] : undefined,
    })),
  }
}
