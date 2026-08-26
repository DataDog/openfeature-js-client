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
import type { Allocation, Condition, Flag, Split, VariationType, Version } from '../configuration/generated/ufc_pb'
import type { PreparedRulesResponse } from '../configuration/prepared-rules-response'
import { type TimeStamp, timeStampNow } from '../time'
import { encodeUtf8 } from '../utf8'
import { coerceToNumber, coerceToString, compileRegex } from './condition-helpers'
import { FlagConfigurationError, InvalidContextError, TargetingKeyMissingError } from './errors'
import { createEvaluationTimestampMetadata } from './evaluationMetadata'
import { getOwnProperty } from './getOwnProperty'
import { compareVersions, isParsedVersion, parseVersion } from './semver'
import { sha256 } from './sha256'
import { MD5Sharder } from './sharders'
import {
  UFC_NUMERIC_COMPARATOR,
  UFC_REASON,
  UFC_SHA256_STRING_COMPARATOR,
  UFC_STRING_COMPARATOR,
  UFC_VARIATION_TYPE,
  UFC_VERSION_COMPARATOR,
} from './ufc-enums'

const SUPPORTED_FEATURE_LEVEL = 0

export function evaluateProtobufConfiguration<T extends FlagValueType>(
  configuration: PreparedRulesResponse,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  evaluationTimestampMs: TimeStamp = timeStampNow()
): ResolutionDetails<FlagTypeToValue<T>> {
  const { targetingKey } = context
  const flag = getOwnProperty(configuration.flags, flagKey)
  if (!flag) {
    logger.debug('returning default value because flag is not found', { flagKey, targetingKey })
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
        targetingKey,
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

    const conditionResults = new Map<number, boolean>()
    for (const allocation of flag.allocations) {
      if (!matchesCondition(allocation.targetingConditionIndex, configuration, context, conditionResults)) {
        continue
      }
      const partitionKey = computePartitionKey(allocation, configuration, context, evaluationTimestampMs)
      const split = allocation.splits.find((candidate) => matchesSplit(candidate, partitionKey))
      if (!split) continue

      const variation = atIndex(flag.variations, split.variationIndex, 'split variation')
      const variationKey = atIndex(configuration.strings, variation.keyStringIndex, 'variation key')
      const value = variationValue(flag, variation.value, configuration)
      logger.debug('evaluated a flag', { flagKey, targetingKey, assignment: value })
      return {
        value: value as FlagTypeToValue<T>,
        reason: resolutionReason(split),
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
        targetingKey,
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
    if (error instanceof InvalidContextError) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'INVALID_CONTEXT' as ErrorCode,
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

  logger.debug('returning default assignment because no allocation matched', { flagKey, targetingKey })
  return {
    value: defaultValue,
    reason: 'DEFAULT',
    flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
  }
}

function matchesCondition(
  index: number | undefined,
  configuration: PreparedRulesResponse,
  attributes: EvaluationContext,
  results: Map<number, boolean>
): boolean {
  if (index === undefined) return true
  const cached = results.get(index)
  if (cached !== undefined) return cached
  const condition = atIndex(configuration.conditions, index, 'condition')
  let result: boolean
  if (condition.kind.case === 'all') {
    result = condition.kind.value.conditionIndexes.every((child) => {
      if (child >= index) throw new FlagConfigurationError('Condition must only reference preceding conditions')
      return matchesCondition(child, configuration, attributes, results)
    })
  } else if (condition.kind.case === 'any') {
    result = condition.kind.value.conditionIndexes.some((child) => {
      if (child >= index) throw new FlagConfigurationError('Condition must only reference preceding conditions')
      return matchesCondition(child, configuration, attributes, results)
    })
  } else {
    result = matchesLeafCondition(condition, configuration, attributes)
  }
  results.set(index, result)
  return result
}

function matchesLeafCondition(
  condition: Condition,
  configuration: PreparedRulesResponse,
  context: EvaluationContext
): boolean {
  const kind = condition.kind
  if (kind.case === undefined || kind.case === 'all' || kind.case === 'any') {
    throw new FlagConfigurationError('Unsupported condition')
  }
  const value = attributeValueAt(configuration, kind.value.attributeIndex, context)
  if (kind.case === 'attributePresence') return kind.value.expectNull ? value == null : value != null
  if (value == null) return false

  if (kind.case === 'numeric') {
    const expected = kind.value.comparand
    if (Number.isNaN(expected)) throw new FlagConfigurationError('Invalid numeric comparator')
    const actual = coerceToNumber(value)
    if (actual === undefined) return false
    if (kind.value.comparator === UFC_NUMERIC_COMPARATOR.LESS_THAN) return actual < expected
    if (kind.value.comparator === UFC_NUMERIC_COMPARATOR.LESS_THAN_OR_EQUAL) return actual <= expected
    if (kind.value.comparator === UFC_NUMERIC_COMPARATOR.GREATER_THAN) return actual > expected
    if (kind.value.comparator === UFC_NUMERIC_COMPARATOR.GREATER_THAN_OR_EQUAL) return actual >= expected
    throw new FlagConfigurationError('Unsupported numeric comparator')
  }
  if (kind.case === 'regex') {
    const attributeValue = coerceToString(value)
    if (attributeValue === undefined) return false
    const matches = compiledRegexAt(configuration, kind.value.regexIndex).test(attributeValue) // dd-iac-scan ignore-line
    return kind.value.negate ? !matches : matches
  }
  if (kind.case === 'stringMembership') {
    const attributeValue = coerceToString(value)
    if (attributeValue === undefined) return false
    const included = containsInternedString(kind.value.stringIndexes, attributeValue, configuration.strings)
    return kind.value.negate ? !included : included
  }
  if (kind.case === 'sha256Membership') {
    const attributeValue = coerceToString(value)
    if (attributeValue === undefined) return false
    const included = containsBytes(kind.value.sha256, saltedSha256(kind.value.salt, encodeUtf8(attributeValue)))
    return kind.value.negate ? !included : included
  }
  if (kind.case === 'version') {
    const expected = versionAt(configuration.versions, kind.value.versionIndex)
    if (typeof value !== 'string') return false
    const actual = parseVersion(value)
    if (!actual) return false
    const comparison = compareVersions(actual, expected)
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.EQUAL) return comparison === 0
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.NOT_EQUAL) return comparison !== 0
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.LESS_THAN) return comparison < 0
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.LESS_THAN_OR_EQUAL) return comparison <= 0
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.GREATER_THAN) return comparison > 0
    if (kind.value.comparator === UFC_VERSION_COMPARATOR.GREATER_THAN_OR_EQUAL) return comparison >= 0
    throw new FlagConfigurationError('Unsupported version comparator')
  }
  if (kind.case === 'stringComparison') {
    const attributeValue = coerceToString(value)
    if (attributeValue === undefined) return false
    const expected = atIndex(configuration.strings, kind.value.stringIndex, 'condition string')
    if (kind.value.comparator === UFC_STRING_COMPARATOR.STARTS_WITH) return attributeValue.startsWith(expected)
    if (kind.value.comparator === UFC_STRING_COMPARATOR.ENDS_WITH) return attributeValue.endsWith(expected)
    if (kind.value.comparator === UFC_STRING_COMPARATOR.CONTAINS) return attributeValue.includes(expected)
    throw new FlagConfigurationError('Unsupported string comparator')
  }
  if (kind.case === 'sha256StringComparison') {
    const attributeValue = coerceToString(value)
    if (attributeValue === undefined) return false
    const encoded = encodeUtf8(attributeValue)
    const extracted = extractUtf8Bytes(encoded, kind.value.length, kind.value.comparator)
    if (!extracted) return false
    return compareBytes(saltedSha256(kind.value.salt, extracted), kind.value.sha256) === 0
  }
  throw new FlagConfigurationError('Unsupported condition')
}

function versionAt(versions: Version[], index: number): Version {
  const version = atIndex(versions, index, 'version')
  if (!isParsedVersion(version)) throw new FlagConfigurationError('Invalid version comparator')
  return version
}

function saltedSha256(salt: Uint8Array, value: Uint8Array): Uint8Array {
  const input = new Uint8Array(salt.length + value.length)
  input.set(salt)
  input.set(value, salt.length)
  return sha256(input)
}

function extractUtf8Bytes(value: Uint8Array, length: number, comparator: number): Uint8Array | undefined {
  let start: number
  if (comparator === UFC_SHA256_STRING_COMPARATOR.STARTS_WITH) start = 0
  else if (comparator === UFC_SHA256_STRING_COMPARATOR.ENDS_WITH) start = value.length - length
  else throw new FlagConfigurationError('Unsupported SHA-256 string comparator')
  if (length > value.length) return undefined
  const end = start + length
  if (!isUtf8Boundary(value, start) || !isUtf8Boundary(value, end)) return undefined
  return value.subarray(start, end)
}

function isUtf8Boundary(value: Uint8Array, index: number): boolean {
  return index === 0 || index === value.length || (value[index] & 0xc0) !== 0x80
}

function compiledRegexAt(configuration: PreparedRulesResponse, index: number): RegExp {
  const cache = configuration.evaluationRegexCache
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

function computePartitionKey(
  allocation: Allocation,
  configuration: PreparedRulesResponse,
  context: EvaluationContext,
  evaluationTimestampMs: TimeStamp
): number[] {
  const partitionKey: number[] = []
  for (const partition of allocation.partitionKey) {
    if (partition.kind.case === 'time') {
      partitionKey.push(evaluationTimestampMs)
    } else if (partition.kind.case === 'shardMd5') {
      const attribute = atIndex(configuration.attributes, partition.kind.value.attributeIndex, 'partition attribute')
      const value = attributeValue(attribute, configuration, context)
      if (value == null) {
        if (attribute.kind.case === 'targetingKey') throw new TargetingKeyMissingError()
        throw new InvalidContextError()
      }
      const upperBound = safeInteger(partition.kind.value.totalShards, 'Total shards')
      if (upperBound <= 0) throw new FlagConfigurationError('Total shards must be positive')
      const partitionValue = coerceToString(value)
      if (partitionValue === undefined) throw new InvalidContextError()
      partitionKey.push(new MD5Sharder().getShard(`${partition.kind.value.salt}${partitionValue}`, upperBound))
    } else {
      throw new FlagConfigurationError('Unsupported partition key')
    }
  }
  return partitionKey
}

function attributeValueAt(
  configuration: PreparedRulesResponse,
  index: number,
  context: EvaluationContext
): EvaluationContextValue | undefined {
  return attributeValue(atIndex(configuration.attributes, index, 'condition attribute'), configuration, context)
}

function attributeValue(
  attribute: PreparedRulesResponse['attributes'][number],
  configuration: PreparedRulesResponse,
  context: EvaluationContext
): EvaluationContextValue | undefined {
  if (attribute.kind.case === 'targetingKey') return context.targetingKey
  if (attribute.kind.case !== 'attributePath') throw new FlagConfigurationError('Unsupported attribute reference')

  const { segments } = attribute.kind.value
  if (segments.length === 0 || segments[0].kind.case !== 'objectKeyStringIndex') {
    throw new FlagConfigurationError('Invalid attribute path')
  }

  let value: unknown = context
  for (const segment of segments) {
    if (segment.kind.case === 'objectKeyStringIndex') {
      if (!isContextObject(value)) return undefined
      const key = atIndex(configuration.strings, segment.kind.value, 'attribute path')
      value = getOwnProperty(value, key)
    } else if (segment.kind.case === 'arrayIndex') {
      if (!Array.isArray(value)) return undefined
      value = Object.prototype.hasOwnProperty.call(value, segment.kind.value) ? value[segment.kind.value] : undefined
    } else {
      throw new FlagConfigurationError('Invalid attribute path')
    }
  }
  return value as EvaluationContextValue | undefined
}

function isContextObject(value: unknown): value is Record<string, EvaluationContextValue | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

function matchesSplit(split: Split, partitionKey: number[]): boolean {
  if (split.ranges.length !== partitionKey.length) {
    throw new FlagConfigurationError('Invalid split')
  }
  return partitionKey.every((value, index) => {
    const range = atIndex(split.ranges, index, 'partition range')
    return (range.from === undefined || value >= range.from) && (range.to === undefined || value < range.to)
  })
}

function variationValue(
  flag: Flag,
  value: Flag['variations'][number]['value'],
  configuration: PreparedRulesResponse
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
  if (value.case === 'jsonStringIndex') return jsonValueAt(configuration, value.value)
  throw new FlagConfigurationError('Variation value is missing')
}

function resolutionReason(split: Split): ResolutionReason {
  if (split.reason === UFC_REASON.TARGETING_MATCH) return 'TARGETING_MATCH'
  if (split.reason === UFC_REASON.SPLIT) return 'SPLIT'
  if (split.reason === UFC_REASON.STATIC) return 'STATIC'
  if (split.reason === UFC_REASON.DEFAULT) return 'DEFAULT'
  return 'UNKNOWN'
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
  return indexes.some((index) => atIndex(strings, index, 'condition string') === value)
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

function jsonValueAt(configuration: PreparedRulesResponse, index: number): FlagValue {
  const cache = configuration.evaluationJsonCache
  const cached = cache.get(index)
  if (cached && !cached.valid) throw new FlagConfigurationError('JSON variation value is invalid')
  if (cached) return cached.value

  const serialized = atIndex(configuration.jsonStrings, index, 'JSON variation value')
  try {
    const parsed = JSON.parse(serialized) as FlagValue
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error()
    cache.set(index, { valid: true, value: parsed })
    return parsed
  } catch {
    cache.set(index, { valid: false })
    throw new FlagConfigurationError('JSON variation value is invalid')
  }
}

function containsBytes(values: Uint8Array[], value: Uint8Array): boolean {
  return values.some((candidate) => compareBytes(candidate, value) === 0)
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}
