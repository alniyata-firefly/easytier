import { describe, expect, it } from 'vitest'
import { normalizeUplinkInventory } from '../src/modules/uplinkInventoryRpc'
import { inventoryFailure } from '../src/modules/uplinkInventory'

describe('target uplink inventory RPC decoding', () => {
  it('uses actual manual eligibility and keeps every target NIC, including down and virtual NICs', () => {
    expect(normalizeUplinkInventory({ supported: true, sampled_at_unix_ms: '1792030000000', interfaces: [
      { name: 'Ethernet 2', addresses: [{ address: '192.0.2.46', prefix_length: 24 }, { address: '2001:db8:7::46', prefix_length: 64 }], kind: 'ethernet', manual_selectable: true, up: false, auto_eligible: false },
      { name: 'wg0', kind: 'wireguard', manual_selectable: true },
      { name: 'lo', kind: 'loopback', addresses: [{ address: '::1', prefix_length: 128 }] },
    ] }).interfaces).toEqual([
      { name: 'Ethernet 2', index: undefined, addresses: ['192.0.2.46/24', '2001:db8:7::46/64'], kind: 'ethernet', up: false, selectable: true },
      { name: 'wg0', index: undefined, addresses: [], kind: 'wireguard', up: undefined, selectable: true },
      { name: 'lo', index: undefined, addresses: ['::1/128'], kind: 'loopback', up: undefined, selectable: false },
    ])
  })
  it('handles protobuf omitted defaults without inventing supported inventory', () => {
    expect(normalizeUplinkInventory({ supported: true })).toEqual({ interfaces: [] })
    for (const payload of [{}, { supported: false }]) {
      try { normalizeUplinkInventory(payload); throw new Error('should reject') } catch (error) { expect(inventoryFailure(error)).toBe('unsupported') }
    }
  })
  it('rejects partial or malformed inventories instead of pretending missing NICs disappeared', () => {
    for (const payload of [null, { supported: true, interfaces: null }, { supported: true, interfaces: [{ name: 'eth0' }, { name: 'eth0' }] }, { supported: true, interfaces: [{ name: 'eth0', addresses: [{}] }] }]) {
      try { normalizeUplinkInventory(payload); throw new Error('should reject') } catch (error) { expect(inventoryFailure(error)).toBe('failed') }
    }
  })
})
