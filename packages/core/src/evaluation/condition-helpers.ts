export function compileRegex(pattern: string): RegExp {
  const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/)
  const flags = inlineFlags ? [...new Set(inlineFlags[1])].join('') : ''
  const source = (inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern).split('[:alnum:]').join('A-Za-z0-9')
  return new RegExp(source, flags)
}

export function coerceToString(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return undefined
}

export function coerceToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return undefined
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}
