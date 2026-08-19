import type { EvaluationContext } from '@openfeature/core'
import type { PrecomputedConfigurationResponse, PrecomputedFlag } from './configuration'

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
  value: unknown
): { response: PrecomputedConfigurationResponse; flagErrors?: Record<string, string> } | { error: string } {
  if (!isRecord(value)) return { error: 'Precomputed configuration response must be an object' }
  if (!isRecord(value.data)) return { error: 'Precomputed configuration response is missing data' }
  if (!isRecord(value.data.attributes)) {
    return { error: 'Precomputed configuration response is missing attributes' }
  }
  const { createdAt, flags } = value.data.attributes
  if (typeof createdAt !== 'string' && (typeof createdAt !== 'number' || !Number.isFinite(createdAt))) {
    return { error: 'Precomputed configuration createdAt is invalid' }
  }
  if (!isRecord(flags)) return { error: 'Precomputed configuration flags must be an object' }

  const validFlags: Array<[string, PrecomputedFlag]> = []
  const flagErrors: Array<[string, string]> = []
  for (const [key, flag] of Object.entries(flags)) {
    if (isPrecomputedFlag(flag)) {
      validFlags.push([key, flag])
    } else {
      flagErrors.push([key, 'Invalid precomputed flag configuration'])
    }
  }

  return {
    response: {
      ...value,
      data: {
        ...value.data,
        attributes: {
          ...value.data.attributes,
          flags: Object.fromEntries(validFlags),
        },
      },
    } as PrecomputedConfigurationResponse,
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

function isPrecomputedFlag(value: unknown): value is PrecomputedFlag {
  if (
    !isRecord(value) ||
    typeof value.allocationKey !== 'string' ||
    typeof value.variationKey !== 'string' ||
    typeof value.variationType !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.doLog !== 'boolean'
  ) {
    return false
  }
  const type = value.variationType
  if (type === 'STRING' || type === 'string') return typeof value.variationValue === 'string'
  if (type === 'BOOLEAN' || type === 'boolean') return typeof value.variationValue === 'boolean'
  if (['NUMBER', 'NUMERIC', 'INTEGER', 'number', 'integer', 'float'].includes(type)) {
    return typeof value.variationValue === 'number' && Number.isFinite(value.variationValue)
  }
  if (type === 'OBJECT' || type === 'JSON' || type === 'object') {
    return (
      typeof value.variationValue === 'object' && value.variationValue !== null && isJsonValue(value.variationValue)
    )
  }
  return false
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
