import {
  Action as AclAction,
  ChainType as AclChainType,
  Protocol as AclProtocol,
} from '../generated/proto/acl'
import type { NetworkConfig } from './network'
import type { MessageInfo } from '@protobuf-ts/runtime'
import { NetworkConfig as NetworkConfigPb } from '../generated/proto/api_manage'

const UINT64_MAX = (1n << 64n) - 1n

type JsonRecord = Record<string, unknown>

export function prepareNetworkConfigForProtoJson(config: NetworkConfig): NetworkConfig {
  const prepared = dropUnsupportedJsonValues(applyLegacyAclDefaults(config)) as NetworkConfig
  const record = prepared as JsonRecord
  for (const key of ['instance_recv_bps_limit', 'instanceRecvBpsLimit', 'foreign_relay_bps_limit', 'foreignRelayBpsLimit']) {
    normalizeOptionalUint64(record, key)
  }
  return prepared
}

// Protobuf JSON readers deliberately discard fields unknown to this client.
// Keep them beside the typed fields so an older editor does not silently erase
// a newer server's options when exporting or saving its JSON configuration.
export function preserveUnknownNetworkConfigFields(source: NetworkConfig, target: NetworkConfig): NetworkConfig {
  return mergeUnknownFields(dropUnsupportedJsonValues(source), target, NetworkConfigPb) as NetworkConfig
}

function mergeUnknownFields(source: unknown, target: unknown, type: MessageInfo): unknown {
  if (!isJsonRecord(source) || Array.isArray(source)) return target
  const result: JsonRecord = isJsonRecord(target) && !Array.isArray(target) ? { ...target } : {}
  const known = new Set(type.fields.flatMap(field => [field.name, field.localName, field.jsonName]))
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key) && !['__proto__', 'constructor', 'prototype', 'credential_secret'].includes(key)) result[key] = value
  }
  for (const field of type.fields) {
    if (field.kind !== 'message') continue
    const sourceValue = source[field.localName] ?? source[field.name] ?? source[field.jsonName]
    const targetValue = result[field.localName]
    if (field.repeat) {
      if (!Array.isArray(sourceValue) || !Array.isArray(targetValue)) continue
      result[field.localName] = targetValue.map((value, index) => {
        // Manual peers can be trimmed/reordered by networking normalization;
        // match stable identities to keep future peer properties on that peer.
        let original = sourceValue[index]
        if (isJsonRecord(value)) {
          const identity = ['uri', 'credential_id'].find(key => typeof value[key] === 'string' && value[key])
          if (identity) original = sourceValue.find(item => isJsonRecord(item) && typeof item[identity] === 'string'
            && (item[identity] as string).trim() === value[identity])
        }
        return mergeUnknownFields(original, value, field.T())
      })
    } else {
      const merged = mergeUnknownFields(sourceValue, targetValue, field.T())
      if (targetValue !== undefined || (isJsonRecord(merged) && Object.keys(merged).length)) result[field.localName] = merged
    }
  }
  return result
}

function applyLegacyAclDefaults(config: NetworkConfig): NetworkConfig {
  const acl = config.acl
  const aclV1 = acl?.acl_v1
  if (!Array.isArray(aclV1?.chains)) return config

  return {
    ...config,
    acl: {
      ...acl,
      acl_v1: {
        ...aclV1,
        chains: aclV1.chains.map((chain) => ({
          ...chain,
          chain_type: chain.chain_type ?? AclChainType.UnspecifiedChain,
          default_action: chain.default_action ?? AclAction.Allow,
          rules: (chain.rules ?? []).map((rule) => ({
            ...rule,
            protocol: rule.protocol ?? AclProtocol.Any,
            action: rule.action ?? AclAction.Allow,
          })),
        })),
      },
    },
  }
}

function dropUnsupportedJsonValues(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  // Form state may hold protobuf-ts bigint values (int64/uint64 fields such
  // as managed credential expiry); proto3 JSON represents them as strings,
  // and fromJson rejects raw bigints.
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    return value.map(dropUnsupportedJsonValues).filter((v) => v !== undefined)
  }

  if (isJsonRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, dropUnsupportedJsonValues(v)])
        .filter(([, v]) => v !== undefined),
    )
  }

  return value
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

function normalizeOptionalUint64(obj: JsonRecord, key: string): void {
  const value = obj[key]
  if (value == null) return

  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    delete obj[key]
    return
  }
  if (typeof value !== 'string' && typeof value !== 'number') return

  const trimmed = String(value).trim()
  if (!isUint64String(trimmed)) {
    delete obj[key]
    return
  }

  obj[key] = trimmed
}

function isUint64String(value: string): boolean {
  if (!/^\d+$/.test(value)) return false

  const n = BigInt(value)
  return n >= 0n && n <= UINT64_MAX
}
