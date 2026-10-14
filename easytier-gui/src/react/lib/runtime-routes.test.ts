import { describe, expect, it } from 'vitest';
import type { Route } from '../../../../easytier-web/frontend-lib/src/types/network';
import { runtimeIpv4Label, runtimeNextHopLabel } from './runtime-routes';

describe('runtime route labels', () => {
  it('preserves real protobuf and legacy IPv4 addresses without showing undefined', () => {
    expect(runtimeIpv4Label({ address: { addr: 174325763 }, network_length: 24 })).toBe('10.100.0.3/24');
    expect(runtimeIpv4Label('10.100.0.3/24')).toBe('10.100.0.3/24');
    for (const value of [undefined, null, '', {}]) expect(runtimeIpv4Label(value as Route['ipv4_addr'])).toBe('—');
  });
  it('shows a known next-hop hostname and retains an unknown nonzero next-hop ID', () => {
    const route = { peer_id: 2, next_hop_peer_id: 8 } as Route;
    expect(runtimeNextHopLabel(route, [{ peer_id: 8, hostname: 'gateway' } as Route])).toBe('gateway');
    expect(runtimeNextHopLabel(route, [])).toBe('8');
    expect(runtimeNextHopLabel(route, [{ peer_id: 8 } as Route])).toBe('8');
    expect(runtimeNextHopLabel({ peer_id: 2 } as Route, [])).toBe('—');
    expect(runtimeNextHopLabel({ peer_id: 2, next_hop_peer_id: 0 } as Route, [])).toBe('—');
  });
});
