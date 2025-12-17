import type { FlagValue, FlagValueType } from '@openfeature/core'
import type { Rule } from '../rules/rules'

export type VariantType = 'BOOLEAN' | 'INTEGER' | 'NUMERIC' | 'STRING' | 'JSON'

export interface VariantConfiguration {
  key: string
  value: FlagValue
}

export interface ShardRange {
  start: number
  end: number
}

export interface Shard {
  salt: string
  ranges: ShardRange[]
  totalShards: number
}

export interface Split {
  variationKey: string
  shards: Shard[]
  extraLogging?: Record<string, string>
}

export interface Allocation {
  key: string
  rules?: Rule[]
  startAt?: Date
  endAt?: Date
  splits: Split[]
  doLog?: boolean
}

export interface Flag {
  key: string
  enabled: boolean
  variationType: VariantType
  variations: Record<string, VariantConfiguration>
  allocations: Allocation[]
}

export interface UniversalFlagConfigurationV1 {
  id: string
  createdAt: string
  format: string
  environment: {
    name: string
  }
  flags: Record<string, Flag>
}

export function variantTypeToFlagValueType(variantType: VariantType): FlagValueType {
  if (variantType === 'BOOLEAN') {
    return 'boolean'
  }
  if (variantType === 'STRING') {
    return 'string'
  }
  if (variantType === 'INTEGER' || variantType === 'NUMERIC') {
    return 'number'
  }
  if (variantType === 'JSON') {
    return 'object'
  }
  throw new Error(`Cannot convert variant type to flag value type: ${variantType}`)
}
