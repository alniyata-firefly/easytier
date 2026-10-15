import { UplinkInventoryError, type TargetUplinkInventory } from './uplinkInventory'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Decode the target's unfiltered management inventory, including protobuf JSON defaults. */
export function normalizeUplinkInventory(value: unknown): TargetUplinkInventory {
  const response = object(value)
  if (!response) throw new UplinkInventoryError('failed')
  if (response.supported === false || response.supported === undefined) throw new UplinkInventoryError('unsupported')
  if (response.supported !== true || (response.interfaces !== undefined && !Array.isArray(response.interfaces))) throw new UplinkInventoryError('failed')
  const names = new Set<string>()
  return { interfaces: ((response.interfaces ?? []) as unknown[]).map(value => {
    const iface = object(value)
    if (!iface || typeof iface.name !== 'string' || !iface.name || names.has(iface.name)
      || (iface.addresses !== undefined && !Array.isArray(iface.addresses))
      || (iface.manual_selectable !== undefined && typeof iface.manual_selectable !== 'boolean')
      || (iface.up !== undefined && typeof iface.up !== 'boolean')) throw new UplinkInventoryError('failed')
    names.add(iface.name)
    const addresses = ((iface.addresses ?? []) as unknown[]).map(value => {
      const entry = object(value)
      if (!entry || typeof entry.address !== 'string' || !entry.address
        || (entry.prefix_length !== undefined && (!Number.isInteger(entry.prefix_length) || Number(entry.prefix_length) < 0 || Number(entry.prefix_length) > 128))) throw new UplinkInventoryError('failed')
      return entry.prefix_length === undefined ? entry.address : `${entry.address}/${entry.prefix_length}`
    })
    return { name: iface.name, index: typeof iface.index === 'number' ? iface.index : undefined,
      addresses, kind: typeof iface.kind === 'string' ? iface.kind : 'unknown',
      up: iface.up as boolean | undefined, selectable: iface.manual_selectable === true }
  }) }
}
