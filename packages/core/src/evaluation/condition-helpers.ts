export function compileRegex(pattern: string): RegExp {
  const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/)
  const flags = inlineFlags ? [...new Set(inlineFlags[1])].join('') : ''
  const source = (inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern).split('[:alnum:]').join('A-Za-z0-9')
  return new RegExp(source, flags)
}
