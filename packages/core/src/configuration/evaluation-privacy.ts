import type { EvaluationContext, EvaluationContextValue } from '@openfeature/core'
import { sha256Hex } from '../evaluation/sha256'
import { encodeUtf8, isWellFormedUnicode } from '../utf8'

/** Apply privacy before buffering; discarded context must not participate in aggregation. */
export function captureEvaluationContext(context: EvaluationContext, observeFullData: boolean) {
  const targetingKey = captureTargetingKey(context.targetingKey, observeFullData)
  let targetingContext: Record<string, EvaluationContextValue> | undefined
  if (observeFullData) {
    try {
      const { targetingKey: _targetingKey, ...attributes } = context
      // Own the same JSON representation that will be sent, including nested values.
      targetingContext = JSON.parse(JSON.stringify(attributes))
    } catch {
      // An unserializable context must not prevent counting the evaluation.
    }
  }
  return { targetingKey, targetingContext }
}

function captureTargetingKey(value: unknown, observeFullData: boolean): string | undefined {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) return undefined
  if (observeFullData || value === '') return value
  try {
    return `sha256_${sha256Hex(encodeUtf8(value))}`
  } catch {
    // Never fall back to raw text or discard an evaluation if hashing fails.
    return undefined
  }
}

/** Stable telemetry vocabulary in both consent modes; never emit exception messages. */
export function sanitizeEvaluationError(error: unknown): string | undefined {
  if (error === undefined) return undefined
  if (typeof error !== 'string') return 'GENERAL'
  switch (error) {
    case 'PROVIDER_NOT_READY':
    case 'PROVIDER_FATAL':
    case 'FLAG_NOT_FOUND':
    case 'PARSE_ERROR':
    case 'TYPE_MISMATCH':
    case 'TARGETING_KEY_MISSING':
    case 'INVALID_CONTEXT':
    case 'GENERAL':
      return error
    default:
      return 'GENERAL'
  }
}
