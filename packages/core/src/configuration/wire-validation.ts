import type { EvaluationContext } from '@openfeature/core'
import type { PrecomputedConfigurationResponse } from './configuration'
import { isLowercaseHex, readFlagKeyObfuscation } from './flag-key-obfuscation'

type WireEntry = {
  response: string
  fetchedAt?: number
  etag?: string
}

export type PrecomputedWireEntry = WireEntry & {
  context?: EvaluationContext
}

export function isWireEntry(value: unknown): value is WireEntry {
  return (
    isRecord(value) &&
    typeof value.response === 'string' &&
    (value.fetchedAt === undefined || (typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt))) &&
    (value.etag === undefined || typeof value.etag === 'string')
  )
}

export function isPrecomputedWireEntry(value: unknown): value is PrecomputedWireEntry {
  return isWireEntry(value) && (!('context' in value) || isEvaluationContext(value.context))
}

/** @internal */
export function parsePrecomputedConfigurationResponse(
  value: unknown,
  onInvalidFlag?: (key: string, issue: { field: string; expected: string; actual: unknown }) => void
): { response: PrecomputedConfigurationResponse; flagErrors?: Record<string, string> } | { error: string } {
  if (!isRecord(value)) return { error: 'Precomputed configuration response must be an object' }
  if (!isRecord(value.data)) return { error: 'Precomputed configuration response is missing data' }
  if (!isRecord(value.data.attributes)) {
    return { error: 'Precomputed configuration response is missing attributes' }
  }
  const { createdAt, flags, obfuscated, obfuscation } = value.data.attributes
  const encoding = readFlagKeyObfuscation(obfuscated, obfuscation)
  if ('error' in encoding) return encoding
  if (typeof createdAt !== 'string' && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) {
    return { error: 'Precomputed configuration createdAt is invalid' }
  }
  if (!isRecord(flags)) return { error: 'Precomputed configuration flags must be an object' }

  const flagErrors: Array<[string, string]> = []
  for (const [key, flag] of Object.entries(flags)) {
    if (encoding.encoding && !isLowercaseHex(key, 32)) {
      return { error: 'Obfuscated flag keys must contain 64 lowercase hexadecimal characters' }
    }
    const issue = precomputedFlagIssue(flag)
    if (issue) {
      flagErrors.push([key, 'Invalid precomputed flag configuration'])
      try {
        onInvalidFlag?.(key, issue)
      } catch {
        /* Diagnostic observers cannot affect parsing. */
      }
    }
  }

  return {
    response: value as PrecomputedConfigurationResponse,
    ...(flagErrors.length > 0 ? { flagErrors: Object.fromEntries(flagErrors) } : {}),
  }
}

function isEvaluationContext(value: unknown): value is EvaluationContext {
  return (
    isRecord(value) &&
    (value.targetingKey === undefined || typeof value.targetingKey === 'string') &&
    Object.values(value).every(isJsonValue)
  )
}

function precomputedFlagIssue(value: unknown): { field: string; expected: string; actual: unknown } | undefined {
  if (!isRecord(value)) return { field: '$', expected: 'object', actual: value }
  for (const field of ['allocationKey', 'variationKey', 'variationType', 'reason']) {
    if (typeof value[field] !== 'string') return { field, expected: 'string', actual: value[field] }
  }
  if (typeof value.doLog !== 'boolean') return { field: 'doLog', expected: 'boolean', actual: value.doLog }
  const type = value.variationType
  let expected: string
  let valid: boolean
  if (type === 'STRING' || type === 'string') {
    expected = 'string'
    valid = typeof value.variationValue === 'string'
  } else if (type === 'BOOLEAN' || type === 'boolean') {
    expected = 'boolean'
    valid = typeof value.variationValue === 'boolean'
  } else if (['NUMBER', 'NUMERIC', 'INTEGER', 'number', 'integer', 'float'].includes(type as string)) {
    expected = 'finite number'
    valid = typeof value.variationValue === 'number' && Number.isFinite(value.variationValue)
  } else if (type === 'OBJECT' || type === 'JSON' || type === 'object') {
    expected = 'JSON value'
    valid = isJsonValue(value.variationValue)
  } else return { field: 'variationType', expected: 'supported variation type', actual: type }
  if (!valid) return { field: 'variationValue', expected, actual: value.variationValue }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
