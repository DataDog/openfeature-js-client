// Protobuf descriptors initialize during import, so configure non-browser runtimes first.
import './protobuf-text-encoding'
import { fromBinary, type Message } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import type { FlagValue } from '@openfeature/core'
import {
  type Allocation,
  type Condition,
  OperatorType,
  type Rule,
  type UniversalFlagConfigurationV1,
  type VariantType,
} from '../evaluation'
import {
  FlagsConfigurationSchema,
  type Allocation as ProtoAllocation,
  type Condition as ProtoCondition,
  type FlagsConfiguration as ProtoConfiguration,
  type Flag as ProtoFlag,
  Reason as ProtoReason,
  VariationType as ProtoVariationType,
} from './generated/ufc_pb'

export function decodeUniversalFlagConfiguration(response: string): UniversalFlagConfigurationV1 {
  const configuration = fromBinary(FlagsConfigurationSchema, decodeBase64(response))
  validateSafeIntegers(configuration)
  return mapConfiguration(configuration)
}

function decodeBase64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    throw new Error('Invalid base64')
  }
  const unpadded = input.replace(/=+$/, '')
  const padding = input.length - unpadded.length
  const remainder = unpadded.length % 4
  if (remainder === 1 || (padding > 0 && (input.length % 4 !== 0 || padding !== (4 - remainder) % 4))) {
    throw new Error('Invalid base64 padding')
  }
  if (remainder > 1) {
    const lastValue = base64Value(unpadded.charCodeAt(unpadded.length - 1))
    const unusedBits = remainder === 2 ? 4 : 2
    if ((lastValue & ((1 << unusedBits) - 1)) !== 0) throw new Error('Non-canonical base64')
  }
  return base64Decode(input)
}

function base64Value(code: number): number {
  return code >= 65 && code <= 90
    ? code - 65
    : code >= 97 && code <= 122
      ? code - 71
      : code >= 48 && code <= 57
        ? code + 4
        : code === 43
          ? 62
          : 63
}

function mapConfiguration(proto: ProtoConfiguration): UniversalFlagConfigurationV1 {
  const flags: UniversalFlagConfigurationV1['flags'] = {}
  for (const [key, flag] of Object.entries(proto.flags)) {
    if (flag.minimumFeatureLevel > 0) continue
    try {
      flags[key] = {
        key,
        enabled: true,
        variationType: mapVariationType(flag.variationType),
        variations: mapVariations(flag, proto),
        allocations: flag.allocations.flatMap((allocation) => mapAllocation(allocation, flag, proto)),
      }
    } catch {}
  }
  return {
    createdAt: proto.createdAt ? timestampToISOString(proto.createdAt) : new Date(0).toISOString(),
    format: 'SERVER',
    observeFullEvaluationData: proto.observeFullEvaluationData,
    environment: { name: proto.environmentName },
    flags,
  }
}

function mapVariationType(type: ProtoVariationType): VariantType {
  const types: Partial<Record<ProtoVariationType, VariantType>> = {
    [ProtoVariationType.STRING]: 'STRING',
    [ProtoVariationType.INTEGER]: 'INTEGER',
    [ProtoVariationType.NUMERIC]: 'NUMERIC',
    [ProtoVariationType.BOOLEAN]: 'BOOLEAN',
    [ProtoVariationType.JSON]: 'JSON',
  }
  const result = types[type]
  if (!result) throw new Error(`Unsupported variation type: ${type}`)
  return result
}

function mapVariations(flag: ProtoFlag, proto: ProtoConfiguration) {
  const result: UniversalFlagConfigurationV1['flags'][string]['variations'] = {}
  const expectedCases: Partial<Record<ProtoVariationType, string>> = {
    [ProtoVariationType.STRING]: 'stringValueIndex',
    [ProtoVariationType.INTEGER]: 'integerValue',
    [ProtoVariationType.NUMERIC]: 'numericValue',
    [ProtoVariationType.BOOLEAN]: 'booleanValue',
    [ProtoVariationType.JSON]: 'jsonStringIndex',
  }
  flag.variations.forEach((variation) => {
    if (hasUnknownFields(variation)) throw new Error('Unsupported variation value')
    const key = atIndex(proto.strings, variation.keyStringIndex, 'variation key')
    if (variation.value.case !== expectedCases[flag.variationType]) {
      throw new Error('Variation value kind does not match its flag type')
    }

    let value: FlagValue
    switch (variation.value.case) {
      case 'stringValueIndex':
        value = atIndex(proto.strings, variation.value.value, 'string variation value')
        break
      case 'integerValue':
        value = safeInteger(variation.value.value, 'Protobuf int64')
        break
      case 'numericValue':
        value = variation.value.value
        if (!Number.isFinite(value)) throw new Error('Numeric variation value is not finite')
        break
      case 'booleanValue':
        value = variation.value.value
        break
      case 'jsonStringIndex':
        value = parseJsonVariation(atIndex(proto.jsonStrings, variation.value.value, 'JSON variation value'))
        break
      default:
        throw new Error('Variation value is missing')
    }
    result[key] = { key, value }
  })
  return result
}

function parseJsonVariation(serialized: string): FlagValue {
  const value: unknown = JSON.parse(serialized)
  if (!isJsonValue(value)) throw new Error('JSON variation value is invalid')
  return value
}

function isJsonValue(value: unknown): value is FlagValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return (
    typeof value === 'object' && value !== null && Object.values(value as Record<string, unknown>).every(isJsonValue)
  )
}

function mapAllocation(allocation: ProtoAllocation, flag: ProtoFlag, proto: ProtoConfiguration): Allocation[] {
  if (allocation.partitionKey.some((partition) => hasUnknownFields(partition) || partition.kind.case === undefined)) {
    throw new Error('Unsupported partition key kind')
  }
  const rules =
    allocation.targetingConditionIndex === undefined
      ? undefined
      : mapConditionToRules(allocation.targetingConditionIndex, proto, new Set())
  if (rules?.length === 0) return []

  return allocation.splits.map((split) => {
    if (split.ranges.length !== allocation.partitionKey.length) {
      throw new Error('Partition key and range cardinality differ')
    }
    const shards = allocation.partitionKey.flatMap((partition, index) => {
      if (partition.kind.case === undefined) throw new Error('Unsupported partition key kind')
      if (partition.kind.case === 'time') return []

      const totalShards = safeInteger(partition.kind.value.totalShards, 'Protobuf uint64')
      if (totalShards <= 0) throw new Error('Total shards must be positive')
      const start =
        split.ranges[index].from === undefined ? 0 : safeInteger(split.ranges[index].from, 'Protobuf uint64')
      const end =
        split.ranges[index].to === undefined ? totalShards : safeInteger(split.ranges[index].to, 'Protobuf uint64')
      if (start < 0 || start > end || end > totalShards) throw new Error('Shard range is out of bounds')
      return [
        {
          salt: partition.kind.value.salt,
          totalShards,
          attribute:
            partition.kind.value.attributeNameIndex === undefined
              ? undefined
              : atIndex(proto.attributeNames, partition.kind.value.attributeNameIndex, 'partition attribute'),
          hashMode: 'PROTOBUF_V1' as const,
          ranges: [{ start, end }],
        },
      ]
    })
    const variation = atIndex(flag.variations, split.variationIndex, 'split variation')
    let start: number | undefined
    let end: number | undefined
    allocation.partitionKey.forEach((partition, index) => {
      if (partition.kind.case !== 'time') return
      const range = split.ranges[index]
      if (range.from !== undefined) {
        const value = safeInteger(range.from, 'Protobuf uint64')
        start = start === undefined ? value : Math.max(start, value)
      }
      if (range.to !== undefined) {
        const value = safeInteger(range.to, 'Protobuf uint64')
        end = end === undefined ? value : Math.min(end, value)
      }
    })
    if (start !== undefined && end !== undefined && start >= end) {
      end = start
    }

    return {
      key: allocation.key,
      rules,
      startAt: start === undefined ? undefined : dateFromMillis(start, 'start time'),
      endAt: end === undefined ? undefined : dateFromMillis(end, 'end time'),
      doLog: allocation.logExposureEvent,
      splits: [
        {
          variationKey: atIndex(proto.strings, variation.keyStringIndex, 'variation key'),
          shards,
          serialId: split.serialId,
          reason: split.reason === ProtoReason.UNSPECIFIED ? undefined : mapReason(split.reason),
        },
      ],
    }
  })
}

function mapConditionToRules(index: number, proto: ProtoConfiguration, ancestors: Set<number>): Rule[] {
  if (ancestors.has(index)) throw new Error('Condition graph contains a cycle')
  const condition = atIndex(proto.conditions, index, 'condition')
  if (hasUnknownFields(condition)) throw new Error('Unsupported condition kind')
  const nextAncestors = new Set(ancestors).add(index)
  if (condition.kind.case === 'all') {
    let combinations: Condition[][] = [[]]
    for (const child of condition.kind.value.conditionIndexes) {
      const childRules = mapConditionToRules(child, proto, nextAncestors)
      if (childRules.length === 0) return []
      if (combinations.length > Math.floor(10000 / childRules.length)) {
        throw new Error('Condition expansion is too large')
      }
      combinations = combinations.flatMap((left) => childRules.map((right) => [...left, ...right.conditions]))
    }
    return combinations.map((conditions) => ({ conditions }))
  }
  if (condition.kind.case === 'any') {
    const rules: Rule[] = []
    for (const child of condition.kind.value.conditionIndexes) {
      rules.push(...mapConditionToRules(child, proto, nextAncestors))
      if (rules.length > 10000) throw new Error('Condition expansion is too large')
    }
    return rules
  }
  return [{ conditions: [mapLeafCondition(condition, proto)] }]
}

function mapLeafCondition(condition: ProtoCondition, proto: ProtoConfiguration): Condition {
  const kind = condition.kind
  if (kind.case === 'numeric') {
    if (hasUnknownFields(kind.value)) {
      throw new Error('Numeric condition value is invalid')
    }
    const comparator = kind.value.comparator
    if (comparator.case === undefined || !Number.isFinite(comparator.value)) {
      throw new Error('Numeric condition value is invalid')
    }
    const operators = {
      lessThan: OperatorType.LT,
      lessThanOrEqual: OperatorType.LTE,
      greaterThan: OperatorType.GT,
      greaterThanOrEqual: OperatorType.GTE,
    } as const
    const operator = operators[comparator.case]
    return {
      operator,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: comparator.value,
    }
  }
  if (kind.case === 'regex') {
    if (hasUnknownFields(kind.value)) throw new Error('Unsupported regex comparator')
    const comparator = kind.value.comparator
    if (comparator.case === undefined) throw new Error('Regex condition comparator is missing')
    const operator = comparator.case === 'matches' ? OperatorType.MATCHES : OperatorType.NOT_MATCHES
    return {
      operator,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: atIndex(proto.regexes, comparator.value, 'regex'),
    }
  }
  if (kind.case === 'stringMembership') {
    if (hasUnknownFields(kind.value)) throw new Error('Unsupported string membership comparator')
    const comparator = kind.value.comparator
    if (comparator.case === undefined) throw new Error('String membership comparator is missing')
    const operator = comparator.case === 'oneOf' ? OperatorType.ONE_OF : OperatorType.NOT_ONE_OF
    return {
      operator,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: comparator.value.values.map((index) => atIndex(proto.strings, index, 'condition string')),
    }
  }
  if (kind.case === 'sha256Membership') {
    if (hasUnknownFields(kind.value)) throw new Error('Unsupported SHA-256 comparator')
    const comparator = kind.value.comparator
    if (comparator.case === undefined) throw new Error('SHA-256 comparator is missing')
    const operator = comparator.case === 'oneOfSha256' ? OperatorType.ONE_OF_SHA256 : OperatorType.NOT_ONE_OF_SHA256
    if (comparator.value.hashes.some((hash) => hash.length !== 32)) {
      throw new Error('SHA-256 condition hash is invalid')
    }
    return {
      operator,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: {
        salt: [...kind.value.salt],
        hashes: comparator.value.hashes.map(bytesToHex),
      },
    }
  }
  if (kind.case === 'attributePresence') {
    if (hasUnknownFields(kind.value)) throw new Error('Unsupported attribute presence condition')
    return {
      operator: OperatorType.IS_NULL,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: kind.value.expectNull,
    }
  }
  if (kind.case === 'semver') {
    if (hasUnknownFields(kind.value)) throw new Error('Unsupported SemVer comparator')
    const comparator = kind.value.comparator
    if (comparator.case === undefined) throw new Error('SemVer condition comparator is missing')
    const operators = {
      semverEqual: OperatorType.SEMVER_EQUAL,
      semverNotEqual: OperatorType.SEMVER_NOT_EQUAL,
      semverLessThan: OperatorType.SEMVER_LT,
      semverLessThanOrEqual: OperatorType.SEMVER_LTE,
      semverGreaterThan: OperatorType.SEMVER_GT,
      semverGreaterThanOrEqual: OperatorType.SEMVER_GTE,
    } as const
    const operator = operators[comparator.case]
    return {
      operator,
      attribute: atIndex(proto.attributeNames, kind.value.attributeNameIndex, 'condition attribute'),
      value: atIndex(proto.semvers, comparator.value, 'SemVer'),
    }
  }
  throw new Error('Unsupported condition kind')
}

function mapReason(reason: ProtoReason): 'TARGETING_MATCH' | 'SPLIT' | 'STATIC' | 'DEFAULT' {
  const reasons: Partial<Record<ProtoReason, 'TARGETING_MATCH' | 'SPLIT' | 'STATIC' | 'DEFAULT'>> = {
    [ProtoReason.TARGETING_MATCH]: 'TARGETING_MATCH',
    [ProtoReason.SPLIT]: 'SPLIT',
    [ProtoReason.STATIC]: 'STATIC',
    [ProtoReason.DEFAULT]: 'DEFAULT',
  }
  const mapped = reasons[reason]
  if (!mapped) throw new Error(`Unsupported split reason: ${reason}`)
  return mapped
}

function timestampToISOString(timestamp: { seconds: bigint; nanos: number }): string {
  if (timestamp.nanos < 0 || timestamp.nanos > 999999999) throw new Error('Timestamp nanos are out of range')
  return new Date(safeInteger(timestamp.seconds, 'Protobuf int64') * 1000 + timestamp.nanos / 1e6).toISOString()
}

function dateFromMillis(value: number, description: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${description} is outside the JavaScript date range`)
  return date
}

function validateSafeIntegers(configuration: ProtoConfiguration): void {
  if (configuration.createdAt) safeInteger(configuration.createdAt.seconds, 'Protobuf int64')
  for (const flag of Object.values(configuration.flags)) {
    for (const variation of flag.variations) {
      if (variation.value.case === 'integerValue') safeInteger(variation.value.value, 'Protobuf int64')
    }
    for (const allocation of flag.allocations) {
      for (const partitionKey of allocation.partitionKey) {
        if (partitionKey.kind.case === 'shardMd5') {
          safeInteger(partitionKey.kind.value.totalShards, 'Protobuf uint64')
        }
      }
      for (const split of allocation.splits) {
        for (const range of split.ranges) {
          if (range.from !== undefined) safeInteger(range.from, 'Protobuf uint64')
          if (range.to !== undefined) safeInteger(range.to, 'Protobuf uint64')
        }
      }
    }
  }
}

function safeInteger(value: bigint | string, description: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result.toString() !== value.toString()) {
    throw new Error(`${description} is outside the JavaScript safe integer range`)
  }
  return result
}

function hasUnknownFields(message: Message): boolean {
  return (message.$unknown?.length ?? 0) > 0
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function atIndex<T>(items: T[], index: number, description: string): T {
  const value = items[index]
  if (value === undefined) throw new Error(`Invalid ${description} index: ${index}`)
  return value
}
