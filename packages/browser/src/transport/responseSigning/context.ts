import type { EvaluationContext, EvaluationContextValue } from '@openfeature/web-sdk'

// Use the Date internal slot so dates from another window are recognized too.
function dateTime(value: object): number | undefined {
  try {
    return Date.prototype.getTime.call(value)
  } catch {
    return undefined
  }
}

const dateSerializationMethods = ['toJSON', 'toISOString', 'valueOf', 'toString', Symbol.toPrimitive] as const

function findPropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  for (let prototype: object | null = value; prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    if (descriptor) return descriptor
  }
}

function hasDefaultDateSerialization(value: object): boolean {
  // The native methods can come from another window.
  return dateSerializationMethods.every((name) => {
    const method: unknown = findPropertyDescriptor(value, name)?.value
    return (
      typeof method === 'function' &&
      Function.prototype.toString.call(method) === Function.prototype.toString.call(Date.prototype[name])
    )
  })
}

/** Copy supported context values without converting dates to strings or sharing mutable values. */
export function cloneSigningContext(
  context: EvaluationContext,
  preserveRequestSerialization = false
): EvaluationContext {
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
    if (preserveRequestSerialization) {
      const toJSON = time === undefined ? findPropertyDescriptor(value, 'toJSON') : undefined
      const unsupported =
        time === undefined
          ? toJSON?.get !== undefined || typeof toJSON?.value === 'function'
          : !hasDefaultDateSerialization(value)
      if (unsupported) throw new TypeError('Context has custom request serialization')
    }
    if (time !== undefined) return new Date(time)
    if (Array.isArray(value)) return value.map(clone)
    return cloneObject(value as Record<string, EvaluationContextValue>)
  }
  return cloneObject(context)
}

/** A full context identity with distinct encodings for dates, arrays and objects. */
export function signingContextKey(context: EvaluationContext): string {
  function canonical(value: EvaluationContextValue): unknown {
    if (value === undefined) return ['undefined']
    if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)]
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
