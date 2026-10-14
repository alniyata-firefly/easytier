import type { Route } from '../../../../easytier-web/frontend-lib/src/types/network';
import { ipv4InetToString } from '../../../../easytier-web/frontend-lib/src/modules/utils';

export function runtimeIpv4Label(address: Route['ipv4_addr'] | undefined): string {
  if (typeof address === 'string') return address || '—';
  return address?.address ? ipv4InetToString(address) : '—';
}

export function runtimeNextHopLabel(route: Route, routes: Route[]): string {
  const peerId = route.next_hop_peer_id;
  if (peerId == null || peerId === 0) return '—';
  // A remote next hop may not have its own route row yet. Keep its real ID.
  return routes.find(next => next.peer_id === peerId)?.hostname || String(peerId);
}
