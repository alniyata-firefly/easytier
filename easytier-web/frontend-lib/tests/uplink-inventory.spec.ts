import { describe, expect, it } from 'vitest'
import {
  buildUplinkOptions, inventoryFailure, toggleUplinkSelection, UplinkInventoryError,
  type TargetUplinkInventory,
} from '../src/modules/uplinkInventory'

const inventory: TargetUplinkInventory = {
  interfaces: [
    { name: 'Ethernet 2', index: 4, addresses: ['10.7.0.46/24', 'fd00:7::46/64'], up: true, kind: 'ethernet', selectable: true },
    { name: '以太网 备用', index: 8, addresses: ['192.168.1.5/24'], up: true, kind: 'ethernet', selectable: true },
    { name: 'wg0', index: 12, addresses: ['fd00:8::1/64'], up: true, kind: 'wireguard', selectable: false, unavailable_reason: 'overlay' },
    { name: 'eth-down', index: 13, addresses: [], up: false, kind: 'ethernet', selectable: false, unavailable_reason: 'down' },
  ],
}

describe('target uplink inventory options', () => {
  it('retains the full target inventory, including NICs outside the current allowlist', () => {
    const rows = buildUplinkOptions(inventory, ['Ethernet 2'], true)
    expect(rows.map(row => row.name)).toEqual(['Ethernet 2', '以太网 备用', 'wg0', 'eth-down'])
    expect(rows[0]).toMatchObject({ selected: true, availability: 'available', stale: false })
    expect(rows[1]).toMatchObject({ selected: false, selectable: true, availability: 'available' })
    expect(rows[2]).toMatchObject({ selectable: false, availability: 'unavailable', unavailable_reason: 'overlay' })
    expect(rows[3]).toMatchObject({ selectable: false, up: false, availability: 'unavailable' })
  })

  it('retains a lost saved interface as a removable missing row only after a fresh success', () => {
    const selected = ['Ethernet 2', 'old NIC 名称']
    const rows = buildUplinkOptions(inventory, selected, true)
    expect(rows[rows.length - 1]).toEqual({ name: 'old NIC 名称', addresses: [], kind: '', selectable: false,
      source: 'saved', availability: 'missing', selected: true, stale: false })
    expect(toggleUplinkSelection(selected, 'old NIC 名称', false)).toEqual(['Ethernet 2'])
    expect(selected).toEqual(['Ethernet 2', 'old NIC 名称'])
  })

  it('distinguishes empty successful inventory from failed, unsupported, or unrequested inventory', () => {
    expect(buildUplinkOptions({ interfaces: [] }, ['eth0'], true)[0].availability).toBe('missing')
    for (const error of [new UplinkInventoryError('failed'), new UplinkInventoryError('unsupported'), new UplinkInventoryError('offline')]) {
      expect(inventoryFailure(error)).toBe(error.kind)
      expect(buildUplinkOptions(undefined, ['eth0'], false)[0]).toMatchObject({ availability: 'unverified', selected: true })
    }
    expect(buildUplinkOptions(undefined, ['eth0'], true)[0].availability).toBe('unverified')
  })

  it('keeps stale inventory details without asserting current availability or removing saved names', () => {
    const rows = buildUplinkOptions(inventory, ['Ethernet 2', 'missing now?'], false)
    expect(rows[0]).toMatchObject({ addresses: ['10.7.0.46/24', 'fd00:7::46/64'], availability: 'unverified', stale: true })
    expect(rows[rows.length - 1]).toMatchObject({ name: 'missing now?', availability: 'unverified', selected: true, stale: true })
    expect(inventory.interfaces[0]).not.toHaveProperty('availability')
    rows[0].addresses.push('test')
    expect(inventory.interfaces[0].addresses).not.toContain('test')
  })

  it('does not invent link state when the target cannot report it or a saved NIC is absent', () => {
    const rows = buildUplinkOptions({ interfaces: [{ name: 'unknown-state', addresses: [], kind: '', selectable: true }] }, ['lost'], true)
    expect(rows[0].up).toBeUndefined()
    expect(rows[1].up).toBeUndefined()
    expect(rows[1]).not.toHaveProperty('up')
  })

  it('preserves exact Unicode names, spaces and order while toggling without silent pruning', () => {
    const selected = ['Ethernet 2', '  网卡 空格  ', 'old NIC']
    expect(toggleUplinkSelection(selected, 'Ethernet 2', true)).toEqual(selected)
    expect(toggleUplinkSelection(selected, '以太网 备用', true)).toEqual([...selected, '以太网 备用'])
    expect(toggleUplinkSelection(selected, 'old NIC', false)).toEqual(['Ethernet 2', '  网卡 空格  '])
    expect(toggleUplinkSelection(selected, '不存在', false)).toEqual(selected)
    expect(buildUplinkOptions(undefined, [...selected, 'old NIC'], false).map(row => row.name)).toEqual(selected)
  })
})

describe('uplink inventory failure classification', () => {
  it('recognizes explicit errors and offline state without inferring device status from network failures', () => {
    expect(inventoryFailure(new UplinkInventoryError('offline', 'device is disconnected'))).toBe('offline')
    expect(inventoryFailure({ kind: 'offline' })).toBe('offline')
    for (const error of [new Error('Network Error'), new Error('DNS lookup failed: eth0.local'), new Error('device offline?'),
      { response: { status: 503 } }, { status: 502 }, undefined]) expect(inventoryFailure(error)).toBe('failed')
  })

  it('recognizes endpoint or RPC incompatibility without treating every not-found as unsupported', () => {
    for (const status of [404, 405, 501]) expect(inventoryFailure({ response: { status } })).toBe('unsupported')
    for (const error of [new Error('RPC method not found'), new Error('method "GetUplinkInventory" not found'),
      { code: -32601 }, { response: { data: { error: { code: -32601, message: 'Method not found' } } } },
      new Error('RPC unimplemented'), new Error('Method not implemented'), new Error('InvalidMethodIndex(8)'), { code: 'InvalidMethodIndex' },
      new Error('command get_network_interfaces not found'), new Error('command `get_network_interfaces` not found')]) expect(inventoryFailure(error)).toBe('unsupported')
    for (const error of [new Error('interface not found'), new Error('DNS methodnotfound.example failed'),
      new Error('unsupported address family'), { status: 500 }]) expect(inventoryFailure(error)).toBe('failed')
  })

  it('recognizes an absent target session before treating HTTP404 as an old endpoint', () => {
    for (const data of [{ error: 'Session not found' }, { error: 'Other error: Session not found' },
      'Session not found', { error: { message: 'Session not found' } }]) {
      expect(inventoryFailure({ response: { status: 404, data } })).toBe('offline')
    }
    expect(inventoryFailure({ response: { status: 404, data: { error: 'Not Found' } } })).toBe('unsupported')
    expect(inventoryFailure(new Error('Session not found'))).toBe('failed')
  })

  it('recognizes an old Core RPC index failure even when the proxy returns HTTP500', () => {
    for (const message of ['Invalid method index:9, service:WebClientService', 'unknown method']) {
      expect(inventoryFailure({ response: { status: 500, data: { error: message } } })).toBe('unsupported')
    }
  })

  it('does not classify authentication errors or timeouts as offline or unsupported', () => {
    for (const status of [401, 403]) {
      for (const error of ['Session not found', 'Invalid method index:9, service:WebClientService']) {
        expect(inventoryFailure({ response: { status, data: { error } } })).toBe('failed')
      }
    }
    for (const code of ['ECONNABORTED', 'ETIMEDOUT']) {
      expect(inventoryFailure({ code, message: 'timeout', response: { status: 404, data: { error: 'Session not found' } } })).toBe('failed')
    }
    expect(inventoryFailure(new Error('request timeout'))).toBe('failed')
  })
})
