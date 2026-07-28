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
import { compareSemver, compileRegex } from './condition-helpers'
import { TargetingKeyMissingError } from './errors'
import { createEvaluationTimestampMetadata } from './evaluationMetadata'
import { getOwnProperty } from './getOwnProperty'
import { sha256 } from './sha256'
import { MD5Sharder } from './sharders'
import { UFC_REASON, UFC_VARIATION_TYPE } from './ufc-enums'

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
  if (!typeMatches(type, flag.variationType)) {
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

  try {
    for (const allocation of flag.allocations) {
      if (
        allocation.targetingConditionIndex !== undefined &&
        !matchesCondition(allocation.targetingConditionIndex, configuration, subjectAttributes, new Set<number>())
      ) {
        continue
      }
      const split = allocation.splits.find((candidate) =>
        matchesSplit(candidate, allocation, configuration, subjectKey, subjectAttributes, evaluationTimestampMs)
      )
      if (!split) continue

      const variation = flag.variations[split.variationIndex]
      const variationKey = configuration.strings[variation.keyStringIndex]
      const value = variationValue(variation.value, configuration)
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
  index: number,
  configuration: FlagsConfiguration,
  subjectAttributes: EvaluationContext,
  ancestors: Set<number>
): boolean {
  if (ancestors.has(index)) throw new Error('Condition graph contains a cycle')
  const condition = configuration.conditions[index]
  if (!condition) throw new Error(`Invalid condition index: ${index}`)
  const nextAncestors = new Set(ancestors).add(index)
  if (condition.kind.case === 'all') {
    return condition.kind.value.conditionIndexes.every((child) =>
      matchesCondition(child, configuration, subjectAttributes, nextAncestors)
    )
  }
  if (condition.kind.case === 'any') {
    return condition.kind.value.conditionIndexes.some((child) =>
      matchesCondition(child, configuration, subjectAttributes, nextAncestors)
    )
  }
  return matchesLeafCondition(condition, configuration, subjectAttributes)
}

function matchesLeafCondition(
  condition: Condition,
  configuration: FlagsConfiguration,
  subjectAttributes: EvaluationContext
): boolean {
  const kind = condition.kind
  if (kind.case === undefined || kind.case === 'all' || kind.case === 'any') return false
  const attribute = configuration.attributeNames[kind.value.attributeNameIndex]
  const value = subjectAttributes[attribute]
  if (kind.case === 'attributePresence') return kind.value.expectNull ? value == null : value != null
  if (value == null) return false

  if (kind.case === 'numeric') {
    const actual = Number(value)
    const expected = kind.value.comparator.value
    if (!Number.isFinite(actual) || expected === undefined) return false
    if (kind.value.comparator.case === 'lessThan') return actual < expected
    if (kind.value.comparator.case === 'lessThanOrEqual') return actual <= expected
    if (kind.value.comparator.case === 'greaterThan') return actual > expected
    if (kind.value.comparator.case === 'greaterThanOrEqual') return actual >= expected
    return false
  }
  if (kind.case === 'regex') {
    if (kind.value.comparator.case === undefined) return false
    const pattern = configuration.regexes[kind.value.comparator.value]
    let matches: boolean
    try {
      matches = compileRegex(pattern).test(String(value)) // dd-iac-scan ignore-line
    } catch {
      return false
    }
    return kind.value.comparator.case === 'matches' ? matches : !matches
  }
  if (kind.case === 'stringMembership') {
    if (kind.value.comparator.case === undefined) return false
    const included = containsInternedString(kind.value.comparator.value.values, String(value), configuration.strings)
    return kind.value.comparator.case === 'oneOf' ? included : !included
  }
  if (kind.case === 'sha256Membership') {
    if (kind.value.comparator.case === undefined) return false
    const encoded = encodeUtf8(String(value))
    const input = new Uint8Array(kind.value.salt.length + encoded.length)
    input.set(kind.value.salt)
    input.set(encoded, kind.value.salt.length)
    const included = containsBytes(kind.value.comparator.value.hashes, sha256(input))
    return kind.value.comparator.case === 'oneOfSha256' ? included : !included
  }
  if (kind.case === 'semver') {
    if (kind.value.comparator.case === undefined) return false
    const expected = configuration.semvers[kind.value.comparator.value]
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

function matchesSplit(
  split: Split,
  allocation: Allocation,
  configuration: FlagsConfiguration,
  subjectKey: string | null | undefined,
  subjectAttributes: EvaluationContext,
  evaluationTimestampMs: TimeStamp
): boolean {
  return allocation.partitionKey.every((partition, index) => {
    const range = split.ranges[index]
    let coordinate: number
    let upperBound: number | undefined
    if (partition.kind.case === 'time') {
      coordinate = evaluationTimestampMs
    } else if (partition.kind.case === 'shardMd5') {
      let value: EvaluationContextValue
      if (partition.kind.value.attributeNameIndex === undefined) {
        if (subjectKey == null) throw new TargetingKeyMissingError()
        value = subjectKey
      } else {
        const attribute = configuration.attributeNames[partition.kind.value.attributeNameIndex]
        const attributeValue = attribute === 'targetingKey' ? subjectKey : subjectAttributes[attribute]
        if (attributeValue == null) return false
        value = attributeValue
      }
      upperBound = Number(partition.kind.value.totalShards)
      coordinate = protobufSharder.getShard(`${partition.kind.value.salt}${String(value)}`, upperBound)
    } else {
      return false
    }
    const from = range.from === undefined ? 0 : Number(range.from)
    const to = range.to === undefined ? upperBound : Number(range.to)
    return coordinate >= from && (to === undefined || coordinate < to)
  })
}

function variationValue(value: Flag['variations'][number]['value'], configuration: FlagsConfiguration): FlagValue {
  if (value.case === 'stringValueIndex') return configuration.strings[value.value]
  if (value.case === 'integerValue') return Number(value.value)
  if (value.case === 'numericValue' || value.case === 'booleanValue') return value.value
  if (value.case === 'jsonStringIndex') return JSON.parse(configuration.jsonStrings[value.value]) as FlagValue
  throw new Error('Variation value is missing')
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

function typeMatches(type: FlagValueType, variationType: VariationType): boolean {
  if (type === 'boolean') return variationType === UFC_VARIATION_TYPE.BOOLEAN
  if (type === 'string') return variationType === UFC_VARIATION_TYPE.STRING
  if (type === 'number') {
    return variationType === UFC_VARIATION_TYPE.INTEGER || variationType === UFC_VARIATION_TYPE.NUMERIC
  }
  return variationType === UFC_VARIATION_TYPE.JSON
}

function variationTypeToFlagValueType(variationType: VariationType): FlagValueType {
  if (variationType === UFC_VARIATION_TYPE.BOOLEAN) return 'boolean'
  if (variationType === UFC_VARIATION_TYPE.STRING) return 'string'
  if (variationType === UFC_VARIATION_TYPE.INTEGER || variationType === UFC_VARIATION_TYPE.NUMERIC) return 'number'
  if (variationType === UFC_VARIATION_TYPE.JSON) return 'object'
  throw new Error(`Unsupported variation type: ${variationType}`)
}

function containsInternedString(indexes: number[], value: string, strings: string[]): boolean {
  let low = 0
  let high = indexes.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const candidate = strings[indexes[middle]]
    if (candidate === value) return true
    if (candidate < value) low = middle + 1
    else high = middle - 1
  }
  return false
}

function containsBytes(values: Uint8Array[], value: Uint8Array): boolean {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const comparison = compareBytes(values[middle], value)
    if (comparison === 0) return true
    if (comparison < 0) low = middle + 1
    else high = middle - 1
  }
  return false
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

const protobufSharder = new MD5Sharder()
