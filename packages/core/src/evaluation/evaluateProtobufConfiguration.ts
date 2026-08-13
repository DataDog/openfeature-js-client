import type {
  ErrorCode,
  EvaluationContext,
  EvaluationContextValue,
  FlagValue,
  FlagValueType,
  Logger,
  ResolutionDetails,
  ResolutionReason,
} from '@openfeature/core'
import type { FlagTypeToValue, PrecomputedFlagMetadata } from '../configuration'
import type {
  Allocation,
  Condition,
  Flag,
  FlagsConfiguration,
  Split,
  VariationType,
} from '../configuration/generated/ufc_pb'
import { type TimeStamp, timeStampNow } from '../time'
import { encodeUtf8 } from '../utf8'
import { compareSemver, compileRegex, isValidSemver } from './condition-helpers'
import { FlagConfigurationError, TargetingKeyMissingError } from './errors'
import { createEvaluationTimestampMetadata } from './evaluationMetadata'
import { getOwnProperty } from './getOwnProperty'
import { sha256 } from './sha256'
import { MD5Sharder } from './sharders'
import { UFC_REASON, UFC_VARIATION_TYPE } from './ufc-enums'

const SUPPORTED_FEATURE_LEVEL = 0
const compiledRegexCache = new WeakMap<FlagsConfiguration, Map<number, RegExp | null>>()

export function evaluateProtobufConfiguration<T extends FlagValueType>(
  configuration: FlagsConfiguration,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  evaluationTimestampMs: TimeStamp = timeStampNow()
): ResolutionDetails<FlagTypeToValue<T>> {
  const { targetingKey: subjectKey, ...remainingContext } = context
  const subjectAttributes = {
    ...(subjectKey != null ? { id: subjectKey } : {}),
    ...remainingContext,
  }
  const flag = getOwnProperty(configuration.flags, flagKey)
  if (!flag) {
    logger.debug('returning default value because flag is not found', { flagKey, subjectKey })
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  try {
    if (flag.minimumFeatureLevel > SUPPORTED_FEATURE_LEVEL) {
      throw new FlagConfigurationError('Flag requires an unsupported feature level')
    }
    const flagValueType = variationTypeToFlagValueType(flag.variationType)
    if (type !== flagValueType) {
      logger.debug('variant value type mismatch, returning default value', {
        flagKey,
        subjectKey,
        expectedType: type,
        variantType: flag.variationType,
      })
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'TYPE_MISMATCH' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }

    for (const allocation of flag.allocations) {
      if (!matchesCondition(allocation.targetingConditionIndex, configuration, subjectAttributes)) {
        continue
      }
      if (allocation.splits.length === 0) continue
      const coordinates = partitionCoordinates(
        allocation,
        configuration,
        subjectKey,
        subjectAttributes,
        evaluationTimestampMs
      )
      if (!coordinates) continue
      const split = allocation.splits.find((candidate) => matchesSplit(candidate, coordinates))
      if (!split) continue

      const variation = atIndex(flag.variations, split.variationIndex, 'split variation')
      const variationKey = atIndex(configuration.strings, variation.keyStringIndex, 'variation key')
      const value = variationValue(flag, variation.value, configuration)
      logger.debug('evaluated a flag', { flagKey, subjectKey, assignment: value })
      return {
        value: value as FlagTypeToValue<T>,
        reason: resolutionReason(split, allocation),
        variant: variationKey,
        flagMetadata: {
          ...createEvaluationTimestampMetadata(evaluationTimestampMs),
          __dd_allocation_key: allocation.key,
          __dd_do_log: allocation.logExposureEvent,
          __dd_split_serial_id: split.serialId,
          allocationKey: allocation.key,
          variationType: variationTypeToFlagValueType(flag.variationType),
          doLog: allocation.logExposureEvent,
        } as PrecomputedFlagMetadata,
      }
    }
  } catch (error) {
    if (error instanceof FlagConfigurationError) {
      logger.error('returning default value because flag configuration is invalid', {
        flagKey,
        subjectKey,
        error: error.message,
      })
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR' as ErrorCode,
        errorMessage: error.message,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
    if (error instanceof TargetingKeyMissingError) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'TARGETING_KEY_MISSING' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
    logger.error('Error evaluating flag', { error })
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'GENERAL' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  logger.debug('returning default assignment because no allocation matched', { flagKey, subjectKey })
  return {
    value: defaultValue,
    reason: 'DEFAULT',
    flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
  }
}

function matchesCondition(
  index: number | undefined,
  configuration: FlagsConfiguration,
  subjectAttributes: EvaluationContext
): boolean {
  if (index === undefined) return true
  const condition = atIndex(configuration.conditions, index, 'condition')
  if (condition.kind.case === 'all') {
    return condition.kind.value.conditionIndexes.every((child) => {
      if (child >= index) throw new FlagConfigurationError('Condition must only reference preceding conditions')
      return matchesCondition(child, configuration, subjectAttributes)
    })
  }
  if (condition.kind.case === 'any') {
    return condition.kind.value.conditionIndexes.some((child) => {
      if (child >= index) throw new FlagConfigurationError('Condition must only reference preceding conditions')
      return matchesCondition(child, configuration, subjectAttributes)
    })
  }
  return matchesLeafCondition(condition, configuration, subjectAttributes)
}

function matchesLeafCondition(
  condition: Condition,
  configuration: FlagsConfiguration,
  subjectAttributes: EvaluationContext
): boolean {
  const kind = condition.kind
  if (kind.case === undefined || kind.case === 'all' || kind.case === 'any') {
    throw new FlagConfigurationError('Unsupported condition')
  }
  const attribute = atIndex(configuration.attributeNames, kind.value.attributeNameIndex, 'condition attribute')
  const value = getOwnProperty(subjectAttributes, attribute)
  if (kind.case === 'attributePresence') return kind.value.expectNull ? value == null : value != null
  if (value == null) return false

  if (kind.case === 'numeric') {
    const actual = Number(value)
    const expected = kind.value.comparator.value
    if (kind.value.comparator.case === undefined || expected === undefined || !Number.isFinite(expected)) {
      throw new FlagConfigurationError('Invalid numeric comparator')
    }
    if (!Number.isFinite(actual)) return false
    if (kind.value.comparator.case === 'lessThan') return actual < expected
    if (kind.value.comparator.case === 'lessThanOrEqual') return actual <= expected
    if (kind.value.comparator.case === 'greaterThan') return actual > expected
    if (kind.value.comparator.case === 'greaterThanOrEqual') return actual >= expected
    return false
  }
  if (kind.case === 'regex') {
    if (kind.value.comparator.case === undefined) {
      throw new FlagConfigurationError('Missing regex comparator')
    }
    const matches = compiledRegexAt(configuration, kind.value.comparator.value).test(String(value)) // dd-iac-scan ignore-line
    return kind.value.comparator.case === 'matches' ? matches : !matches
  }
  if (kind.case === 'stringMembership') {
    if (kind.value.comparator.case === undefined) {
      throw new FlagConfigurationError('Unsupported string membership comparator')
    }
    const included = containsInternedString(kind.value.comparator.value.values, String(value), configuration.strings)
    return kind.value.comparator.case === 'oneOf' ? included : !included
  }
  if (kind.case === 'sha256Membership') {
    if (kind.value.comparator.case === undefined) {
      throw new FlagConfigurationError('Unsupported SHA-256 comparator')
    }
    const encoded = encodeUtf8(String(value))
    const input = new Uint8Array(kind.value.salt.length + encoded.length)
    input.set(kind.value.salt)
    input.set(encoded, kind.value.salt.length)
    const included = containsBytes(kind.value.comparator.value.hashes, sha256(input))
    return kind.value.comparator.case === 'oneOfSha256' ? included : !included
  }
  if (kind.case === 'semver') {
    if (kind.value.comparator.case === undefined) {
      throw new FlagConfigurationError('Missing SemVer comparator')
    }
    const expected = atIndex(configuration.semvers, kind.value.comparator.value, 'SemVer')
    if (!isValidSemver(expected)) throw new FlagConfigurationError('Invalid SemVer comparator')
    const comparison = compareSemver(String(value), expected)
    if (comparison === undefined) return false
    if (kind.value.comparator.case === 'semverEqual') return comparison === 0
    if (kind.value.comparator.case === 'semverNotEqual') return comparison !== 0
    if (kind.value.comparator.case === 'semverLessThan') return comparison < 0
    if (kind.value.comparator.case === 'semverLessThanOrEqual') return comparison <= 0
    if (kind.value.comparator.case === 'semverGreaterThan') return comparison > 0
    return comparison >= 0
  }
  return false
}

function compiledRegexAt(configuration: FlagsConfiguration, index: number): RegExp {
  let cache = compiledRegexCache.get(configuration)
  if (!cache) {
    cache = new Map()
    compiledRegexCache.set(configuration, cache)
  }
  const cached = cache.get(index)
  if (cached === null) throw new FlagConfigurationError('Invalid regular expression')
  if (cached) return cached

  const pattern = atIndex(configuration.regexes, index, 'regex')
  try {
    const regex = compileRegex(pattern)
    cache.set(index, regex)
    return regex
  } catch {
    cache.set(index, null)
    throw new FlagConfigurationError('Invalid regular expression')
  }
}

type PartitionCoordinate = {
  coordinate: number
  upperBound?: number
}

function partitionCoordinates(
  allocation: Allocation,
  configuration: FlagsConfiguration,
  subjectKey: string | null | undefined,
  subjectAttributes: EvaluationContext,
  evaluationTimestampMs: TimeStamp
): PartitionCoordinate[] | undefined {
  const coordinates: PartitionCoordinate[] = []
  for (const partition of allocation.partitionKey) {
    if (partition.kind.case === 'time') {
      coordinates.push({ coordinate: evaluationTimestampMs })
    } else if (partition.kind.case === 'shardMd5') {
      let value: EvaluationContextValue
      if (partition.kind.value.attributeNameIndex === undefined) {
        if (subjectKey == null) throw new TargetingKeyMissingError()
        value = subjectKey
      } else {
        const attribute = atIndex(
          configuration.attributeNames,
          partition.kind.value.attributeNameIndex,
          'partition attribute'
        )
        const attributeValue = attribute === 'targetingKey' ? subjectKey : getOwnProperty(subjectAttributes, attribute)
        if (attributeValue == null) return undefined
        value = attributeValue
      }
      const upperBound = safeInteger(partition.kind.value.totalShards, 'Total shards')
      if (upperBound <= 0) throw new FlagConfigurationError('Total shards must be positive')
      coordinates.push({
        coordinate: protobufSharder.getShard(`${partition.kind.value.salt}${String(value)}`, upperBound),
        upperBound,
      })
    } else {
      throw new FlagConfigurationError('Unsupported partition key')
    }
  }
  return coordinates
}

function matchesSplit(split: Split, coordinates: PartitionCoordinate[]): boolean {
  if (split.ranges.length !== coordinates.length) {
    throw new FlagConfigurationError('Invalid split')
  }
  return coordinates.every(({ coordinate, upperBound }, index) => {
    const range = atIndex(split.ranges, index, 'partition range')
    const from = range.from === undefined ? 0 : safeInteger(range.from, 'Partition range')
    const to = range.to === undefined ? upperBound : safeInteger(range.to, 'Partition range')
    if (to !== undefined && from > to) throw new FlagConfigurationError('Partition range is invalid')
    if (upperBound !== undefined && (from > upperBound || (to !== undefined && to > upperBound))) {
      throw new FlagConfigurationError('Shard range is out of bounds')
    }
    return coordinate >= from && (to === undefined || coordinate < to)
  })
}

function variationValue(
  flag: Flag,
  value: Flag['variations'][number]['value'],
  configuration: FlagsConfiguration
): FlagValue {
  const expectedCase = variationValueCase(flag.variationType)
  if (value.case !== expectedCase) {
    throw new FlagConfigurationError('Variation value does not match flag variation type')
  }
  if (value.case === 'stringValueIndex') {
    return atIndex(configuration.strings, value.value, 'string variation value')
  }
  if (value.case === 'integerValue') return safeInteger(value.value, 'Integer variation value')
  if (value.case === 'numericValue') {
    if (!Number.isFinite(value.value)) throw new FlagConfigurationError('Numeric variation value is not finite')
    return value.value
  }
  if (value.case === 'booleanValue') return value.value
  if (value.case === 'jsonStringIndex') {
    const serialized = atIndex(configuration.jsonStrings, value.value, 'JSON variation value')
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      throw new FlagConfigurationError('JSON variation value is invalid')
    }
    if (!isJsonValue(parsed)) throw new FlagConfigurationError('JSON variation value is invalid')
    return parsed
  }
  throw new FlagConfigurationError('Variation value is missing')
}

function resolutionReason(split: Split, allocation: Allocation): ResolutionReason {
  if (split.reason === UFC_REASON.TARGETING_MATCH) return 'TARGETING_MATCH'
  if (split.reason === UFC_REASON.SPLIT) return 'SPLIT'
  if (split.reason === UFC_REASON.STATIC) return 'STATIC'
  if (split.reason === UFC_REASON.DEFAULT) return 'DEFAULT'
  if (allocation.targetingConditionIndex !== undefined) return 'TARGETING_MATCH'
  if (allocation.partitionKey.some((partition) => partition.kind.case === 'shardMd5')) return 'SPLIT'
  if (allocation.partitionKey.some((partition) => partition.kind.case === 'time')) return 'DEFAULT'
  return 'STATIC'
}

function variationTypeToFlagValueType(variationType: VariationType): FlagValueType {
  if (variationType === UFC_VARIATION_TYPE.BOOLEAN) return 'boolean'
  if (variationType === UFC_VARIATION_TYPE.STRING) return 'string'
  if (variationType === UFC_VARIATION_TYPE.INTEGER || variationType === UFC_VARIATION_TYPE.NUMERIC) return 'number'
  if (variationType === UFC_VARIATION_TYPE.JSON) return 'object'
  throw new FlagConfigurationError('Unsupported variation type')
}

function variationValueCase(
  variationType: VariationType
): 'stringValueIndex' | 'integerValue' | 'numericValue' | 'booleanValue' | 'jsonStringIndex' {
  if (variationType === UFC_VARIATION_TYPE.STRING) return 'stringValueIndex'
  if (variationType === UFC_VARIATION_TYPE.INTEGER) return 'integerValue'
  if (variationType === UFC_VARIATION_TYPE.NUMERIC) return 'numericValue'
  if (variationType === UFC_VARIATION_TYPE.BOOLEAN) return 'booleanValue'
  if (variationType === UFC_VARIATION_TYPE.JSON) return 'jsonStringIndex'
  throw new FlagConfigurationError('Unsupported variation type')
}

function containsInternedString(indexes: number[], value: string, strings: string[]): boolean {
  return containsSorted(indexes, (index) => {
    const candidate = atIndex(strings, index, 'condition string')
    return candidate === value ? 0 : candidate < value ? -1 : 1
  })
}

function containsSorted<T>(values: T[], compare: (candidate: T) => number): boolean {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const comparison = compare(values[middle])
    if (comparison === 0) return true
    if (comparison < 0) low = middle + 1
    else high = middle - 1
  }
  return false
}

function safeInteger(value: bigint, description: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || String(result) !== String(value)) {
    throw new FlagConfigurationError(`${description} cannot be represented safely as a JavaScript number`)
  }
  return result
}

function atIndex<T>(items: T[], index: number, description: string): T {
  const value = items[index]
  if (value === undefined) throw new FlagConfigurationError(`Invalid ${description} index`)
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

function containsBytes(values: Uint8Array[], value: Uint8Array): boolean {
  return containsSorted(values, (candidate) => compareBytes(candidate, value))
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

const protobufSharder = new MD5Sharder()
