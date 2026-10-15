import { describe, expect, it } from 'vitest'
import { NetworkConfig as NetworkConfigPb } from '../src/generated/proto/api_manage'
import { normalizeMemberNetworkConfig, normalizeNetworkConfig, toBackendNetworkConfig } from '../src/types/network'

const listFields = ['stun_servers', 'tcp_stun_servers', 'stun_servers_v6', 'tcp_whitelist', 'udp_whitelist'] as const

describe('extended native configuration JSON and wire compatibility', () => {
  it('round-trips the new optional scalar fields through JSON and binary protobuf', () => {
    const source: any = {
      default_protocol: 'udp', foreign_relay_bps_limit: '18446744073709551615',
      disable_relay_kcp: false, disable_relay_quic: true,
      enable_relay_foreign_network_kcp: false, enable_relay_foreign_network_quic: true,
      tld_dns_zone: 'vpn.example.', virtual_ipv6: 'fd00:1234::2/64',
      socks5_proxy: 'socks5://[::1]:1081', instance_name: 'managed-instance', netns: 'vpn-test',
    }
    const form = normalizeNetworkConfig(source)
    const saved: any = toBackendNetworkConfig(form)
    for (const [key, value] of Object.entries(source)) expect(saved[key]).toEqual(value)
    const message = NetworkConfigPb.fromJson(saved)
    const wire = NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(message))
    expect(wire.foreign_relay_bps_limit).toBe(18446744073709551615n)
    expect(wire.disable_relay_kcp).toBe(false)
    expect(wire.enable_relay_foreign_network_kcp).toBe(false)
    expect(wire.virtual_ipv6).toBe(source.virtual_ipv6)
    expect(wire.socks5_proxy).toBe(source.socks5_proxy)
  })

  it.each(listFields)('preserves %s inheritance, explicit empty and populated lists', (key) => {
    const absent = toBackendNetworkConfig(normalizeMemberNetworkConfig({} as any))
    expect(absent[key]).toBeUndefined()
    for (const values of [[], ['first.example:3478', 'second.example:3478']]) {
      const form = normalizeMemberNetworkConfig({ [key]: { values } } as any)
      expect(form[key]).toEqual({ values })
      const saved = toBackendNetworkConfig(form)
      expect(saved[key]).toEqual({ values })
      const decoded = NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(NetworkConfigPb.fromJson(saved as any)))
      expect(decoded[key]).toEqual({ values })
    }
  })

  it.each(['instance_recv_bps_limit', 'foreign_relay_bps_limit'])('retains explicit zero and full uint64 precision for %s', (key) => {
    for (const value of [0, '0', 0n, '9007199254740993', '18446744073709551615']) {
      const form: any = normalizeNetworkConfig({ [key]: value } as any)
      const saved: any = toBackendNetworkConfig(form)
      expect(saved[key]).toBe(String(value))
      const wire = NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(NetworkConfigPb.fromJson(saved)))
      expect((wire as any)[key]).toBe(BigInt(value))
    }
    for (const value of [-1, '-1', '18446744073709551616', Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      const saved: any = toBackendNetworkConfig(normalizeNetworkConfig({ [key]: value } as any))
      expect(saved[key]).toBeUndefined()
    }
  })

  it('reads camel-case JSON uint64 fields without rounding or losing explicit zero', () => {
    const normalized = normalizeNetworkConfig({ instanceRecvBpsLimit: '0', foreignRelayBpsLimit: '9007199254740993' } as any)
    const saved: any = toBackendNetworkConfig(normalized)
    expect(saved.instance_recv_bps_limit).toBe('0')
    expect(saved.foreign_relay_bps_limit).toBe('9007199254740993')
    expect(saved.instanceRecvBpsLimit).toBeUndefined()
    expect(saved.foreignRelayBpsLimit).toBeUndefined()
  })

  it('keeps explicit SOCKS disable separate from inherited and legacy settings', () => {
    const inherited = toBackendNetworkConfig(normalizeMemberNetworkConfig({ enable_socks5: true, socks5_port: 1080 } as any))
    expect(inherited.socks5_proxy).toBeUndefined()
    const disabled = toBackendNetworkConfig(normalizeMemberNetworkConfig({ enable_socks5: true, socks5_port: 1080, socks5_proxy: '' } as any))
    expect(disabled.socks5_proxy).toBe('')
    expect(disabled.enable_socks5).toBe(true)
    expect(disabled.socks5_port).toBe(1080)
    const wire = NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(NetworkConfigPb.fromJson(disabled as any)))
    expect(wire.socks5_proxy).toBe('')
  })

  it('preserves newer JSON fields and nested properties without mixing peer identities', () => {
    const source: any = {
      peer_urls: ['tcp://peer-b:11010', 'tcp://peer-a:11010'],
      peers: [
        { uri: ' tcp://peer-a:11010 ', future_peer_option: 'a' },
        { uri: 'tcp://peer-b:11010', future_peer_option: 'b' },
      ],
      future_core_option: { enabled: false, limit: '9007199254740993' },
      stun_servers: { values: [], future_dns_option: 'keep' },
      secure_mode: { enabled: false, future_security_option: 'keep' },
    }
    const normalized: any = normalizeNetworkConfig(source)
    const saved: any = toBackendNetworkConfig(normalized)
    expect(saved.future_core_option).toEqual(source.future_core_option)
    expect(saved.stun_servers).toEqual(source.stun_servers)
    expect(saved.secure_mode.future_security_option).toBe('keep')
    expect(saved.peers).toEqual([
      { uri: 'tcp://peer-b:11010', future_peer_option: 'b' },
      { uri: 'tcp://peer-a:11010', future_peer_option: 'a' },
    ])
    expect(() => NetworkConfigPb.fromJson(saved, { ignoreUnknownFields: true })).not.toThrow()
  })

  it('does not add new optional fields to an old client configuration', () => {
    const saved: any = toBackendNetworkConfig(normalizeMemberNetworkConfig({ network_name: 'old-client', mtu: 1300 } as any))
    for (const key of [...listFields, 'default_protocol', 'foreign_relay_bps_limit', 'disable_relay_kcp',
      'disable_relay_quic', 'enable_relay_foreign_network_kcp', 'enable_relay_foreign_network_quic',
      'tld_dns_zone', 'virtual_ipv6', 'socks5_proxy', 'instance_name', 'netns']) expect(saved[key]).toBeUndefined()
    expect(saved.mtu).toBe(1300)
  })
})
