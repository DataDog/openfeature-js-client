import type { EvaluationContext } from '@openfeature/core'
import type {
  PrecomputedConfigurationResponse,
  PrecomputedDependencyEvaluation,
  PrecomputedErrorFlag,
} from './configuration'
import {
  type FlagKeyObfuscation,
  isLowercaseHex,
  readFlagKeyObfuscation,
  supportsDependencyKeyEncryption,
} from './flag-key-obfuscation'

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
  const { createdAt, flags, flagEvaluationErrors, obfuscated, obfuscation } = value.data.attributes
  const encoding = readFlagKeyObfuscation(obfuscated, obfuscation)
  if ('error' in encoding) return encoding
  if (typeof createdAt !== 'string' && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) {
    return { error: 'Precomputed configuration createdAt is invalid' }
  }
  if (!isRecord(flags)) return { error: 'Precomputed configuration flags must be an object' }
  if (flagEvaluationErrors !== undefined && !isRecord(flagEvaluationErrors)) {
    return { error: 'Precomputed configuration flagEvaluationErrors must be an object' }
  }
  for (const key of Object.keys(flagEvaluationErrors ?? {})) {
    if (Object.getOwnPropertyDescriptor(flags, key) !== undefined) {
      return { error: 'A precomputed flag cannot have both an assignment and an evaluation error' }
    }
  }

  const flagErrors: Array<[string, string]> = []
  for (const [key, flag] of Object.entries(flags)) {
    if (encoding.encoding && !isLowercaseHex(key, 32)) {
      return { error: 'Obfuscated flag keys must contain 64 lowercase hexadecimal characters' }
    }
    const issue = precomputedFlagIssue(flag, encoding.encoding)
    if (issue) {
      flagErrors.push([key, 'Invalid precomputed flag configuration'])
      try {
        onInvalidFlag?.(key, issue)
      } catch {
        /* Diagnostic observers cannot affect parsing. */
      }
    }
  }
  for (const [key, error] of Object.entries(flagEvaluationErrors ?? {})) {
    if (encoding.encoding && !isLowercaseHex(key, 32)) {
      return { error: 'Obfuscated flag keys must contain 64 lowercase hexadecimal characters' }
    }
    if (!isPrecomputedErrorFlag(error, encoding.encoding)) {
      flagErrors.push([key, 'Invalid precomputed flag evaluation error'])
    }
  }

  // Consent is optional for older responses. Wrong types must not reject valid
  // assignments or opt into full telemetry details.
  const attributes = value.data.attributes
  const response =
    attributes.observeFullEvaluationData === undefined
      ? value
      : {
          ...value,
          data: {
            ...value.data,
            attributes: { ...attributes, observeFullEvaluationData: attributes.observeFullEvaluationData === true },
          },
        }
  return {
    response: response as PrecomputedConfigurationResponse,
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

function precomputedFlagIssue(
  value: unknown,
  encoding?: FlagKeyObfuscation
): { field: string; expected: string; actual: unknown } | undefined {
  if (!isRecord(value)) return { field: '$', expected: 'object', actual: value }
  if (!isDependencyEvaluations(value.dependencyEvaluations, encoding)) {
    return {
      field: 'dependencyEvaluations',
      expected: 'valid dependency evaluations',
      actual: value.dependencyEvaluations,
    }
  }
  for (const field of ['allocationKey', 'variationKey', 'variationType', 'reason']) {
    if (typeof value[field] !== 'string') return { field, expected: 'string', actual: value[field] }
  }
  if (value.reason === 'ERROR') return { field: 'reason', expected: 'non-error reason', actual: value.reason }
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

function isPrecomputedErrorFlag(value: unknown, encoding?: FlagKeyObfuscation): value is PrecomputedErrorFlag {
  return (
    isRecord(value) &&
    value.reason === 'ERROR' &&
    typeof value.errorCode === 'string' &&
    (value.errorMessage === undefined || typeof value.errorMessage === 'string') &&
    isDependencyEvaluations(value.dependencyEvaluations, encoding)
  )
}

function isDependencyEvaluations(value: unknown, encoding?: FlagKeyObfuscation): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  if (encoding !== undefined && value.length > 0 && !supportsDependencyKeyEncryption(encoding)) return false
  const flagKeys = new Set<string>()
  for (const evaluation of value) {
    if (
      !isDependencyEvaluation(evaluation) ||
      (encoding !== undefined && !isEncryptedDependencyKey(evaluation.flagKey)) ||
      flagKeys.has(evaluation.flagKey)
    ) {
      return false
    }
    flagKeys.add(evaluation.flagKey)
  }
  return true
}

function isEncryptedDependencyKey(value: string): boolean {
  return value.length >= 38 && value.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isDependencyEvaluation(value: unknown): value is PrecomputedDependencyEvaluation {
  if (!isRecord(value) || typeof value.flagKey !== 'string') return false
  if (value.reason === 'ERROR') {
    return (
      typeof value.errorCode === 'string' &&
      (value.errorMessage === undefined || typeof value.errorMessage === 'string') &&
      value.isPresentInAssignment === undefined
    )
  }
  return (
    typeof value.isPresentInAssignment === 'boolean' &&
    value.reason == null &&
    value.errorCode == null &&
    value.errorMessage == null
  )
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
