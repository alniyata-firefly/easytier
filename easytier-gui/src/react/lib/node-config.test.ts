import { describe, expect, it } from 'vitest';
import { applyNodePatch, validateNodeParameters, prepareNodeParametersForBackend, parseUint64Input } from './node-config';
import { NetworkTypes } from './shared';
import { normalizeUplinkForTarget, supportsUplinkSelectionForTarget } from './uplink-capabilities';

describe('client configuration boundaries', () => {
  it('preserves IPv6 preference, uint64 limits, and peer public keys through native JSON', () => {
    const config = NetworkTypes.DEFAULT_NETWORK_CONFIG();
    config.peer_urls = ['udp://192.0.2.1:11010'];
    config.peers = [{ uri: config.peer_urls[0], peer_public_key: 'test-peer-key' }];
    config.prefer_ipv6 = true;
    config.instance_recv_bps_limit = '9007199254740993';
    const result = NetworkTypes.normalizeNetworkConfig(NetworkTypes.toBackendNetworkConfig(config));
    expect(result.prefer_ipv6).toBe(true);
    expect(result.instance_recv_bps_limit).toBe('9007199254740993');
    expect(result.peers[0].peer_public_key).toBe('test-peer-key');
  });
  it('compiles public server and standalone choices into their effective native peer lists', () => {
    const config = NetworkTypes.DEFAULT_NETWORK_CONFIG();
    config.peer_urls = ['udp://192.0.2.2:11010'];
    config.networking_method = NetworkTypes.NetworkingMethod.PublicServer;
    config.public_server_url = 'udp://192.0.2.1:11010';
    const server = NetworkTypes.toBackendNetworkConfig(config);
    expect(server.peer_urls).toEqual(['udp://192.0.2.1:11010']);
    config.networking_method = NetworkTypes.NetworkingMethod.Standalone;
    expect(NetworkTypes.toBackendNetworkConfig(config).peer_urls ?? []).toEqual([]);
  });
  it('compiles a temporary credential into secure identity without a shared network secret', () => {
    const config = NetworkTypes.DEFAULT_NETWORK_CONFIG();
    config.network_secret = 'unused-secret'; config.credential_secret = 'test-device-credential';
    const native = NetworkTypes.toBackendNetworkConfig(config);
    expect(native.network_secret).toBeUndefined();
    expect(native.secure_mode?.enabled).toBe(true);
    expect(native.secure_mode?.local_private_key).toBe('test-device-credential');
  });
  it('rejects invalid or overflowing rates without rounding', () => {
    expect(parseUint64Input('18446744073709551615')).toEqual({ valid: true, value: '18446744073709551615' });
    for (const input of ['18446744073709551616', '-1', '1.5', '1e3']) expect(parseUint64Input(input).valid).toBe(false);
  });
  it('validates IPv6 prefix providers and forwarding endpoints', () => {
    expect(validateNodeParameters({ ipv6_public_addr_provider: true, ipv6_public_addr_prefix: '2001:db8::/64' })).toEqual([]);
    expect(validateNodeParameters({ ipv6_public_addr_provider: true, ipv6_public_addr_prefix: '10.0.0.0/24' })).toContainEqual({ path: 'ipv6_public_addr_prefix', key: 'errors.ipv6Cidr', values: undefined });
    const valid = { proto: 'udp', bind_ip: '::', bind_port: 5353, dst_ip: '2001:db8::2', dst_port: 53 };
    expect(validateNodeParameters({ port_forwards: [valid] })).toEqual([]);
    expect(prepareNodeParametersForBackend({ port_forwards: [valid] }).port_forwards).toEqual([{ ...valid, bind_ip: '[::]', dst_ip: '[2001:db8::2]' }]);
    expect(validateNodeParameters({ port_forwards: [{ ...valid, dst_port: 65536 }] }).some(issue => issue.path === 'port_forwards.0.dst_port')).toBe(true);
  });
});


describe('uplink interface policy', () => {
  it('validates allowlists and clears manual selection when switching to automatic', () => {
    const manual = { uplink: { mode: 'manual', interfaces: ['eth0', 'Ethernet 2'] }, mtu: 1280 };
    expect(validateNodeParameters(manual)).toEqual([]);
    for (const interfaces of [[], ['eth0', 'eth0'], [' eth0'], ['eth0\0']]) expect(validateNodeParameters({ uplink: { mode: 'manual', interfaces } })[0].key).toBe('errors.uplinkInterfaces');
    expect(validateNodeParameters({ uplink: { mode: 'unknown' } })[0].key).toBe('errors.uplinkMode');
    const reset = applyNodePatch(manual, { uplink: { mode: 'auto', interfaces: [] } });
    expect(validateNodeParameters(reset)).toEqual([]);
    expect(reset.uplink).toEqual({ mode: 'auto', interfaces: [] });
    expect(manual.uplink.interfaces).toEqual(['eth0', 'Ethernet 2']);
  });
});


describe('uplink target capabilities', () => {
  it('hides local mobile controls without restricting a mobile viewer of a remote Core', () => {
    for (const platform of ['android', 'ios']) {
      expect(supportsUplinkSelectionForTarget(platform, { mode: 'normal' })).toBe(false);
      expect(supportsUplinkSelectionForTarget(platform, { mode: 'service' })).toBe(false);
      expect(supportsUplinkSelectionForTarget(platform, { mode: 'remote' })).toBe(true);
    }
    for (const platform of ['linux', 'windows', 'macos']) expect(supportsUplinkSelectionForTarget(platform, { mode: 'normal' })).toBe(true);
  });
  it('drops imported local mobile policy while preserving every remote field and the original object', () => {
    const source = { uplink: { mode: 'manual', interfaces: ['eth0'] }, mtu: 1280, future: { keep: true } };
    const local = normalizeUplinkForTarget(source, false);
    expect(local).toEqual({ mtu: 1280, future: { keep: true } });
    expect(normalizeUplinkForTarget(source, true)).toEqual(source);
    expect(source.uplink).toEqual({ mode: 'manual', interfaces: ['eth0'] });
    expect(local.future).toBe(source.future);
  });
});
