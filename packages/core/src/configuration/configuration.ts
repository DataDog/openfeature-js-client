import type { EvaluationContext, FlagValueType, JsonValue, ResolutionReason } from '@openfeature/core'

/**
 * Internal flags configuration for DatadogProvider.
 */
export type FlagsConfiguration = {
  /** @internal */
  precomputed?: PrecomputedConfiguration
}

/** @internal */
export type PrecomputedConfiguration = {
  response: PrecomputedConfigurationResponse
  context?: EvaluationContext
  fetchedAt?: UnixTimestamp
}

// Fancy way to map FlagValueType to expected FlagValue.
/** @internal */
export type FlagTypeToValue<T extends FlagValueType> = {
  boolean: boolean
  string: string
  number: number
  object: JsonValue
}[T]

/** @internal
 * Timestamp in milliseconds since Unix Epoch.
 */
export type UnixTimestamp = number

/** @internal */
export type PrecomputedConfigurationResponse = {
  data: {
    attributes: {
      /** When configuration was generated. */
      createdAt: string
      flags: Record<string, PrecomputedFlag>
    }
  }
}

/** @internal */
export type PrecomputedFlag<T extends FlagValueType = FlagValueType> = {
  allocationKey: string
  variationKey: string
  variationType: T
  variationValue: FlagTypeToValue<T>
  reason: ResolutionReason
  doLog: boolean
  extraLogging: Record<string, unknown>
}

/** @internal */
export type PrecomputedFlagMetadata = {
  allocationKey: string
  variationType: FlagValueType
  doLog: boolean
  serialId?: number
}

/**
 * Check if a stored configuration matches the requested evaluation context.
 * - If the config has no context, it's context-agnostic and matches any request
 * - If the config has a context, it must match the requested context exactly
 */
export function configMatchesContext(
  config: FlagsConfiguration | undefined,
  requestedContext: EvaluationContext
): boolean {
  if (!config?.precomputed) return false

  const storedContext = config.precomputed.context

  // No stored context = context-agnostic config, matches any evaluation context
  if (!storedContext) return true

  // Stored context exists = must match exactly
  return contextsEqual(storedContext, requestedContext)
}

/**
 * Deep equality check for evaluation contexts
 */
function contextsEqual(a: EvaluationContext, b: EvaluationContext): boolean {
  return objectsEqual(a, b)
}

/**
 * Deep equality check for objects
 */
function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()

  if (keysA.length !== keysB.length) return false

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false
    if (!valuesEqual(a[keysA[i]], b[keysB[i]])) return false
  }

  return true
}

/**
 * Type guard for record objects
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep equality check for values (handles primitives, arrays, objects, and dates)
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime()
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((val, idx) => valuesEqual(val, b[idx]))
  }

  if (isRecord(a) && isRecord(b)) {
    return objectsEqual(a, b)
  }

  return false
}
