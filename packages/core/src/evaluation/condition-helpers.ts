export function compileRegex(pattern: string): RegExp {
  const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/)
  const flags = inlineFlags ? [...new Set(inlineFlags[1])].join('') : ''
  const source = (inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern).split('[:alnum:]').join('A-Za-z0-9')
  return new RegExp(source, flags)
}

export function coerceToString(value: unknown): string | undefined {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }

  // OpenFeature context values may include scalar-like structures, such as Date or
  // custom classes. Coerce those while ignoring nested arrays and plain objects.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    try {
      if (value.toString !== Object.prototype.toString) return String(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

export function coerceToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined
  }
  return Number(value)
}
