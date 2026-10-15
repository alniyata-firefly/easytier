export interface TargetUplinkInterface {
  name: string
  index?: number
  addresses: string[]
  up?: boolean
  kind: string
  selectable: boolean
  unavailable_reason?: string
}

export interface TargetUplinkInventory {
  interfaces: TargetUplinkInterface[]
}

export type UplinkInventoryLoader = () => Promise<TargetUplinkInventory>
export type UplinkInventoryFailure = 'offline' | 'unsupported' | 'failed'

export class UplinkInventoryError extends Error {
  readonly kind: UplinkInventoryFailure

  constructor(kind: UplinkInventoryFailure, message: string = kind) {
    super(message)
    this.name = 'UplinkInventoryError'
    this.kind = kind
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Classify transport failures without treating a failed request as an empty inventory. */
export function inventoryFailure(error: unknown): UplinkInventoryFailure {
  if (error instanceof UplinkInventoryError) return error.kind
  const detail = record(error)
  if (detail?.kind === 'offline' || detail?.kind === 'unsupported' || detail?.kind === 'failed') {
    return detail.kind
  }
  const response = record(detail?.response)
  const status = response?.status ?? detail?.status
  if (status === 401 || status === 403 || detail?.code === 'ECONNABORTED'
    || detail?.code === 'ETIMEDOUT' || detail?.name === 'AbortError') return 'failed'

  const data = record(response?.data)
  const rpcError = record(data?.error) ?? record(detail?.error)
  const message = [typeof error === 'string' ? error : undefined, detail?.message,
    typeof response?.data === 'string' ? response.data : undefined,
    typeof detail?.error === 'string' ? detail.error : undefined,
    data?.message, typeof data?.error === 'string' ? data.error : undefined,
    rpcError?.message].filter((value): value is string => typeof value === 'string').join('\n')
  if (status === 404 && /\bsession\s+not\s+found\b/i.test(message)) return 'offline'
  if (status === 404 || status === 405 || status === 501) return 'unsupported'
  if (detail?.code === -32601 || rpcError?.code === -32601
    || detail?.code === 'InvalidMethodIndex' || rpcError?.code === 'InvalidMethodIndex') return 'unsupported'
  if (/\b(?:rpc\s+)?method\s+(?:["'`][^"'`\n]+["'`]\s+)?(?:not\s+found|(?:is\s+)?not\s+implemented)\b/i.test(message)
    || /\brpc\s+(?:method\s+)?(?:unimplemented|unsupported\s+method)\b/i.test(message)
    || /\bInvalidMethodIndex\b/.test(message)
    || /\binvalid\s+method\s+index\b/i.test(message)
    || /\bunknown\s+method\b/i.test(message)
    || /\bcommand\s+[`"']?get_network_interfaces[`"']?\s+not\s+found\b/i.test(message)) {
    return 'unsupported'
  }
  return 'failed'
}

export type UplinkAvailability = 'available' | 'unavailable' | 'missing' | 'unverified'

export interface UplinkOption extends TargetUplinkInterface {
  source: 'inventory' | 'saved'
  availability: UplinkAvailability
  selected: boolean
  stale: boolean
}

/** Saved names are retained verbatim, including names missing from a successful inventory. */
export function buildUplinkOptions(
  inventory: TargetUplinkInventory | undefined,
  selected: string[],
  fresh: boolean,
): UplinkOption[] {
  const selectedNames = new Set(selected)
  const presentNames = new Set<string>()
  const options: UplinkOption[] = (inventory?.interfaces ?? []).map(iface => {
    presentNames.add(iface.name)
    return {
      ...iface,
      addresses: [...iface.addresses],
      source: 'inventory',
      availability: fresh ? (iface.selectable ? 'available' : 'unavailable') : 'unverified',
      selected: selectedNames.has(iface.name),
      stale: !fresh,
    }
  })
  // An absent inventory cannot establish that a saved interface has disappeared.
  const verified = fresh && inventory !== undefined
  for (const name of selectedNames) {
    if (presentNames.has(name)) continue
    options.push({
      name,
      addresses: [],
      kind: '',
      selectable: false,
      source: 'saved',
      availability: verified ? 'missing' : 'unverified',
      selected: true,
      stale: !verified,
    })
  }
  return options
}

/** Callers authorize new selections; removing an unavailable saved name always remains possible. */
export function toggleUplinkSelection(selected: string[], name: string, checked: boolean): string[] {
  if (!checked) return selected.filter(current => current !== name)
  return selected.includes(name) ? [...selected] : [...selected, name]
}
