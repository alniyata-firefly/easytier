import { describe, expect, it } from 'vitest'
import { NetworkConfig as NetworkConfigPb } from '../src/generated/proto/api_manage'
import { DEFAULT_NETWORK_CONFIG, normalizeMemberNetworkConfig, normalizeNetworkConfig, toBackendNetworkConfig } from '../src/types/network'

describe('Core uplink policy browser and native transport', () => {
  it('preserves exact interface names across JSON and binary protobuf', () => {
    const form = { ...DEFAULT_NETWORK_CONFIG(), uplink: { mode: 'manual', interfaces: ['eth0', 'Ethernet 2'] } }
    const dto = toBackendNetworkConfig(form)
    expect(dto.uplink).toEqual(form.uplink)
    expect(normalizeNetworkConfig(JSON.parse(JSON.stringify(dto))).uplink).toEqual(form.uplink)
    const message = NetworkConfigPb.fromJson(dto as any)
    expect(NetworkConfigPb.fromBinary(NetworkConfigPb.toBinary(message)).uplink).toEqual(form.uplink)
  })
  it('does not restore an old manual allowlist after an automatic reset', () => {
    const form = { ...DEFAULT_NETWORK_CONFIG(), uplink: { mode: 'auto', interfaces: [] } }
    const dto = toBackendNetworkConfig(form)
    expect(dto.uplink).toMatchObject({ mode: 'auto' })
    expect(normalizeMemberNetworkConfig(JSON.parse(JSON.stringify(dto))).uplink).toEqual({ mode: 'auto', interfaces: [] })
    const absent = normalizeMemberNetworkConfig(DEFAULT_NETWORK_CONFIG())
    expect(absent.uplink).toBeUndefined()
  })
})
