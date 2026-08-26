import type { EvaluationContext, EvaluationContextValue } from '@openfeature/core'
import type { FlagsConfiguration } from './configuration'

function isDate(value: EvaluationContextValue): value is Date {
  if (value === null || typeof value !== 'object') return false

  try {
    Date.prototype.getTime.call(value)
    return true
  } catch {
    return false
  }
}

function cloneContextValue(value: EvaluationContextValue): EvaluationContextValue {
  if (isDate(value)) {
    return new Date(Date.prototype.getTime.call(value))
  }

  if (Array.isArray(value)) {
    return value.map(cloneContextValue)
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, cloneContextValue(nestedValue)]))
  }

  return value
}

function cloneEvaluationContext(context: EvaluationContext): EvaluationContext {
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [key, cloneContextValue(value)]))
}

/**
 * Return a detached copy of the context from a precomputed configuration.
 *
 * This function returns `undefined` when the configuration has no
 * context-specific precomputed branch. It does not modify the configuration,
 * OpenFeature, or provider state.
 */
export function getPrecomputedContext(configuration: FlagsConfiguration): EvaluationContext | undefined {
  const context = configuration.precomputed?.context

  return context === undefined ? undefined : cloneEvaluationContext(context)
}
