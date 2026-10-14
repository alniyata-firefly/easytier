import { describe, expect, it } from 'vitest'

import { NetworkConfig as NetworkConfigPb } from '../src/generated/proto/api_manage'
import {
  DEFAULT_NETWORK_CONFIG,
  normalizeMemberNetworkConfig,
  normalizeNetworkConfig,
  toBackendNetworkConfig,
} from '../src/types/network'

describe('network config IPv6 preference', () => {
  it('keeps a missing or null member preference inherited in its saved DTO', () => {
    for (const extra of [{}, { prefer_ipv6: null }, { preferIpv6: null }]) {
      const raw: any = { ...DEFAULT_NETWORK_CONFIG(), ...extra }
      if (!Object.hasOwn(extra, 'prefer_ipv6')) delete raw.prefer_ipv6
      const form = normalizeMemberNetworkConfig(raw)
      expect(form.prefer_ipv6).toBeUndefined()
      expect(toBackendNetworkConfig(form)).not.toHaveProperty('prefer_ipv6')
    }
  })

  it.each([
    ['prefer_ipv6', true],
    ['prefer_ipv6', false],
    ['preferIpv6', true],
    ['preferIpv6', false],
  ])('keeps the member override %s=%s after reloading', (field, value) => {
    const raw: any = DEFAULT_NETWORK_CONFIG()
    delete raw.prefer_ipv6
    raw[String(field)] = value
    const form = normalizeMemberNetworkConfig(raw)
    expect(form.prefer_ipv6).toBe(value)
    expect(toBackendNetworkConfig(form)).toHaveProperty('prefer_ipv6', value)
  })

  it('keeps new and legacy configurations disabled by default', () => {
    expect(DEFAULT_NETWORK_CONFIG().prefer_ipv6).toBe(false)
    const legacy = DEFAULT_NETWORK_CONFIG()
    delete legacy.prefer_ipv6
    expect(normalizeNetworkConfig(legacy).prefer_ipv6).toBe(false)
  })

  it.each([true, false])('preserves an explicit %s through the form, DTO and protobuf', (preference) => {
    const form = {
      ...DEFAULT_NETWORK_CONFIG(),
      prefer_ipv6: preference,
    }
    const dto = toBackendNetworkConfig(form)
    expect(dto.prefer_ipv6).toBe(preference)

    const saved = JSON.parse(JSON.stringify(dto))
    expect(normalizeNetworkConfig(saved).prefer_ipv6).toBe(preference)
    const message = NetworkConfigPb.fromJson(dto as any)
    const decoded = NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(message))
    expect(decoded.prefer_ipv6).toBe(preference)
  })

  it('preserves the IPv6 disable setting independently of the preference', () => {
    const dto = toBackendNetworkConfig({
      ...DEFAULT_NETWORK_CONFIG(),
      prefer_ipv6: true,
      disable_ipv6: true,
    })
    expect(dto.prefer_ipv6).toBe(true)
    expect(dto.disable_ipv6).toBe(true)
  })
})
