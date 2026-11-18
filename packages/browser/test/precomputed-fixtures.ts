// Keep response bytes intact: parsing and serializing JSON can round numeric literals.
export function responseBody(fixture: string): string {
  JSON.parse(fixture)
  let depth = 0
  let start: number | undefined
  for (const token of fixture.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
    const value = token[0]
    if (value === '{' || value === '[') depth++
    else if (value === '}' || value === ']') {
      depth--
      if (start !== undefined && depth === 1) return fixture.slice(start, token.index + 1)
    } else if (depth === 1 && JSON.parse(value) === 'response') {
      const separator = fixture.slice(token.index + value.length).match(/^\s*:\s*(?=\{)/)
      if (separator) start = token.index + value.length + separator[0].length
    }
  }
  throw new Error('Fixture must contain a response object')
}
