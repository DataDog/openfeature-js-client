// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { setFlagConfigurationErrors } from './flag-configuration-errors'
import {
  type Allocation,
  type Condition,
  type Flag,
  type FlagsConfiguration,
  FlagsConfigurationSchema,
  Reason,
  VariationType,
} from './generated/ufc_pb'

const SUPPORTED_FEATURE_LEVEL = 0

export function decodeUniversalFlagConfiguration(response: string): FlagsConfiguration {
  const configuration = fromBinary(FlagsConfigurationSchema, base64Decode(response))
  validateTimestamp(configuration)
  const errors = new Map<string, string>()
  for (const [key, flag] of Object.entries(configuration.flags)) {
    if (flag.minimumFeatureLevel > SUPPORTED_FEATURE_LEVEL) {
      errors.set(
        key,
        `Flag requires feature level ${flag.minimumFeatureLevel}, but this SDK supports ${SUPPORTED_FEATURE_LEVEL}`
      )
      continue
    }
    try {
      validateFlag(flag, configuration)
    } catch (error) {
      errors.set(key, error instanceof Error ? error.message : 'Invalid flag configuration')
    }
  }
  setFlagConfigurationErrors(configuration, errors)
  return configuration
}

function validateFlag(flag: Flag, configuration: FlagsConfiguration): void {
  if (!supportedVariationTypes.has(flag.variationType)) {
    throw new Error('Unsupported flag')
  }
  const expectedValueCase = variationValueCases[flag.variationType]
  for (const variation of flag.variations) {
    if (variation.value.case !== expectedValueCase) {
      throw new Error('Unsupported variation')
    }
    atIndex(configuration.strings, variation.keyStringIndex, 'variation key')
    switch (variation.value.case) {
      case 'stringValueIndex':
        atIndex(configuration.strings, variation.value.value, 'string variation value')
        break
      case 'integerValue':
        safeInteger(variation.value.value, 'Integer variation value')
        break
      case 'numericValue':
        if (!Number.isFinite(variation.value.value)) throw new Error('Numeric variation value is not finite')
        break
      case 'jsonStringIndex':
        validateJson(atIndex(configuration.jsonStrings, variation.value.value, 'JSON variation value'))
        break
    }
  }
  for (const allocation of flag.allocations) {
    validateAllocation(allocation, flag, configuration)
  }
}

function validateAllocation(allocation: Allocation, flag: Flag, configuration: FlagsConfiguration): void {
  if (allocation.targetingConditionIndex !== undefined) {
    validateCondition(allocation.targetingConditionIndex, configuration, new Set())
  }
  for (const partition of allocation.partitionKey) {
    if (partition.kind.case === undefined) {
      throw new Error('Unsupported partition key')
    }
    if (partition.kind.case === 'shardMd5') {
      if (partition.kind.value.attributeNameIndex !== undefined) {
        atIndex(configuration.attributeNames, partition.kind.value.attributeNameIndex, 'partition attribute')
      }
      const totalShards = safeInteger(partition.kind.value.totalShards, 'Protobuf uint64')
      if (totalShards <= 0) throw new Error('Total shards must be positive')
    }
  }
  for (const split of allocation.splits) {
    if (split.ranges.length !== allocation.partitionKey.length) {
      throw new Error('Invalid split')
    }
    atIndex(flag.variations, split.variationIndex, 'split variation')
    if (!supportedReasons.has(split.reason)) throw new Error('Unsupported split reason')
    split.ranges.forEach((range, index) => {
      const from = range.from === undefined ? undefined : safeInteger(range.from, 'Protobuf uint64')
      const to = range.to === undefined ? undefined : safeInteger(range.to, 'Protobuf uint64')
      if (from !== undefined && to !== undefined && from > to) throw new Error('Partition range is invalid')
      const partition = allocation.partitionKey[index]
      if (partition.kind.case === 'shardMd5') {
        const totalShards = safeInteger(partition.kind.value.totalShards, 'Protobuf uint64')
        if ((from !== undefined && from > totalShards) || (to !== undefined && to > totalShards)) {
          throw new Error('Shard range is out of bounds')
        }
      }
    })
  }
}

function validateCondition(index: number, configuration: FlagsConfiguration, ancestors: Set<number>): void {
  if (ancestors.has(index)) throw new Error('Condition graph contains a cycle')
  const condition = atIndex(configuration.conditions, index, 'condition')
  if (condition.kind.case === undefined) throw new Error('Unsupported condition')
  const nextAncestors = new Set(ancestors).add(index)
  if (condition.kind.case === 'all' || condition.kind.case === 'any') {
    condition.kind.value.conditionIndexes.forEach((child) => {
      validateCondition(child, configuration, nextAncestors)
    })
    return
  }
  validateLeafCondition(condition, configuration)
}

function validateLeafCondition(condition: Condition, configuration: FlagsConfiguration): void {
  const kind = condition.kind
  if (kind.case === undefined || kind.case === 'all' || kind.case === 'any') {
    throw new Error('Unsupported condition')
  }
  atIndex(configuration.attributeNames, kind.value.attributeNameIndex, 'condition attribute')
  if (kind.case === 'numeric') {
    if (kind.value.comparator.case === undefined || !Number.isFinite(kind.value.comparator.value)) {
      throw new Error('Invalid numeric comparator')
    }
    return
  }
  if (kind.case === 'regex') {
    if (kind.value.comparator.case === undefined) throw new Error('Missing regex comparator')
    atIndex(configuration.regexes, kind.value.comparator.value, 'regex')
    return
  }
  if (kind.case === 'stringMembership') {
    if (kind.value.comparator.case === undefined) {
      throw new Error('Unsupported string membership comparator')
    }
    kind.value.comparator.value.values.forEach((value) => {
      atIndex(configuration.strings, value, 'condition string')
    })
    return
  }
  if (kind.case === 'sha256Membership') {
    if (kind.value.comparator.case === undefined) {
      throw new Error('Unsupported SHA-256 comparator')
    }
    if (kind.value.comparator.value.hashes.some((hash) => hash.length !== 32)) {
      throw new Error('Invalid SHA-256 hash')
    }
    return
  }
  if (kind.case === 'semver') {
    if (kind.value.comparator.case === undefined) throw new Error('Missing SemVer comparator')
    atIndex(configuration.semvers, kind.value.comparator.value, 'SemVer')
  }
}

function validateTimestamp(configuration: FlagsConfiguration): void {
  if (!configuration.createdAt) return
  safeInteger(configuration.createdAt.seconds, 'Protobuf int64')
  if (configuration.createdAt.nanos < 0 || configuration.createdAt.nanos > 999999999) {
    throw new Error('Timestamp nanos are out of range')
  }
}

function validateJson(serialized: string): void {
  const value: unknown = JSON.parse(serialized)
  if (!isJsonValue(value)) throw new Error('JSON variation value is invalid')
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return (
    typeof value === 'object' && value !== null && Object.values(value as Record<string, unknown>).every(isJsonValue)
  )
}

function safeInteger(value: bigint | string, description: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result.toString() !== value.toString()) {
    throw new Error(`${description} cannot be represented safely as a JavaScript number`)
  }
  return result
}

function atIndex<T>(items: T[], index: number, description: string): T {
  const value = items[index]
  if (value === undefined) throw new Error(`Invalid ${description} index: ${index}`)
  return value
}

const supportedVariationTypes = new Set([
  VariationType.STRING,
  VariationType.INTEGER,
  VariationType.NUMERIC,
  VariationType.BOOLEAN,
  VariationType.JSON,
])

const variationValueCases: Partial<
  Record<VariationType, 'stringValueIndex' | 'integerValue' | 'numericValue' | 'booleanValue' | 'jsonStringIndex'>
> = {
  [VariationType.STRING]: 'stringValueIndex',
  [VariationType.INTEGER]: 'integerValue',
  [VariationType.NUMERIC]: 'numericValue',
  [VariationType.BOOLEAN]: 'booleanValue',
  [VariationType.JSON]: 'jsonStringIndex',
}

const supportedReasons = new Set([
  Reason.UNSPECIFIED,
  Reason.TARGETING_MATCH,
  Reason.SPLIT,
  Reason.STATIC,
  Reason.DEFAULT,
])
