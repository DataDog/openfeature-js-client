import type { EvaluationContext, EvaluationContextValue } from '@openfeature/web-sdk'

// Use the Date internal slot so dates from another window are recognized too.
function dateTime(value: object): number | undefined {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return undefined
  }
}

/** Copy supported context values without converting dates to strings or sharing mutable values. */
export function cloneSigningContext(context: EvaluationContext): EvaluationContext {
  function cloneObject(value: Record<string, EvaluationContextValue>): Record<string, EvaluationContextValue> {
    const copy: Record<string, EvaluationContextValue> = {}
    for (const key of Object.keys(value)) {
      // Define own properties so a context key named __proto__ cannot change the prototype.
      Object.defineProperty(copy, key, {
        value: clone(value[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return copy
  }
  function clone(value: EvaluationContextValue): EvaluationContextValue {
    if (value === null || typeof value !== 'object') return value
    const time = dateTime(value)
    if (time !== undefined) return new Date(time)
    if (Array.isArray(value)) return value.map(clone)
    return cloneObject(value as Record<string, EvaluationContextValue>)
  }
  return cloneObject(context)
}

/** A full context identity with distinct encodings for dates, arrays and objects. */
export function signingContextKey(context: EvaluationContext): string {
  function canonical(value: EvaluationContextValue): unknown {
    if (value === null || typeof value !== 'object') return value
    const time = dateTime(value)
    if (time !== undefined) return ['date', Number.isNaN(time) ? null : time]
    if (Array.isArray(value)) return ['array', value.map(canonical)]
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, EvaluationContextValue>)[key])]),
    ]
  }
  return JSON.stringify(canonical(context))
}
