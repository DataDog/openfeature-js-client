import { responseBody } from './precomputed-fixtures'

test('retains numeric tokens, whitespace, and nested response content', () => {
  const body =
    '{ "large": 9007199254740993, "decimal": 1.0000000000000001, "exponent": 1e+30, "nested": [{"response": {}}] }'
  const fixture = `{"description":"response","nested":{"response":{}},"response":${body},"after":{}}`
  expect(responseBody(fixture)).toBe(body)
})

test('ignores braces and escaped quotes inside strings', () => {
  const body = JSON.stringify({ text: 'a "quoted" } value \\ {', nested: { empty: [] } })
  expect(responseBody(`{"response":${body}}`)).toBe(body)
})

test.each(['{}', '{"nested":{"response":{}}}', '{"response":null}', '{"response":[]}', '{"response":'])(
  'rejects an invalid or missing response object: %s',
  (fixture) => expect(() => responseBody(fixture)).toThrow()
)
