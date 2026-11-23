import { evaluatePrecomputedConfiguration } from '../evaluation/precomputed-evaluation'
import { encodePrecomputedFlagKey } from './flag-key-obfuscation'
import {
  INVALID_PRECOMPUTED_NUMBER,
  parsePrecomputedConfigurationJson,
  stringifyPrecomputedConfigurationJson,
} from './precomputed-json'
import { configurationFromPrecomputedString, configurationToPrecomputedString } from './precomputed-wire'
import { configurationFromString, configurationToString } from './wire'
import { parsePrecomputedConfigurationResponse } from './wire-validation'

const context = { targetingKey: 'subject' }
const encoding = { scheme: 'flag-key-sha256-v1' as const, salt: '0'.repeat(32) }
const invalid = [
  '9007199254740993',
  '-9007199254740993',
  '9007199254740993.0',
  '90071992547409930e-1',
  '1e23',
  '1e-999',
  '-1e-999',
  '1e999',
  '-1e999',
  '2e-324',
]
const valid: Array<[string, number]> = [
  ['9007199254740994', 9007199254740994],
  ['-9007199254740994', -9007199254740994],
  ['9007199254740994.0', 9007199254740994],
  ['90071992547409940e-1', 9007199254740994],
  ['1.20000000000000001', 1.2],
  ['1.00000000000000001', 1],
  ['4503599627370497.5', 4503599627370498],
  ['9007199254740993.5', 9007199254740994],
  ['5e-324', 5e-324],
  ['0e-9999', 0],
  ['0e9999', 0],
  ['-0', -0],
  ['1.5e1', 15],
  ['1e20', 1e20],
  ['1267650600228229401496703205376', 2 ** 100],
  ['1E22', 1e22],
  ['1e21', 1e21],
  ['9007199254740992', 2 ** 53],
]

function response(source: string, type: string, key = 'probe', encoded = false) {
  return `{"data":{"attributes":{"createdAt":"2026-11-23T00:00:00Z",${encoded ? `"obfuscated":true,"obfuscation":${JSON.stringify(encoding)},` : ''}"flags":{${JSON.stringify(key)}:{"allocationKey":"allocation","variationKey":"variant","variationType":${JSON.stringify(type)},"variationValue":${source},"reason":"TARGETING_MATCH","doLog":true},"healthy":{"allocationKey":"control","variationKey":"on","variationType":"boolean","variationValue":true,"reason":"STATIC","doLog":false}}}}}`
}

describe.each(['number', 'integer', 'float', 'NUMBER', 'NUMERIC', 'INTEGER'])(
  'precomputed %s numeric conversion',
  (type) => {
    it.each(invalid)('rejects %s as a type mismatch before and after portable round trips', (source) => {
      let configuration = configurationFromPrecomputedString(
        JSON.stringify({ version: 1, precomputed: { context, response: response(source, type) } })
      )
      for (let round = 0; round < 3; round++) {
        configuration = structuredClone(configuration)
        const result = evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, context)
        expect(result).toMatchObject({
          value: -99.5,
          reason: 'ERROR',
          errorCode: 'TYPE_MISMATCH',
          errorMessage: INVALID_PRECOMPUTED_NUMBER,
        })
        expect(result.variant).toBeUndefined()
        expect(evaluatePrecomputedConfiguration(configuration, 'boolean', 'healthy', false, context).value).toBe(true)
        const wire = configurationToPrecomputedString(configuration)
        expect(JSON.parse(wire).precomputed.response).toContain(`"variationValue":${source}`)
        configuration = configurationFromPrecomputedString(wire)
      }
    })

    it.each(valid)('accepts %s', (source, expected) => {
      const configuration = configurationFromPrecomputedString(
        JSON.stringify({ version: 1, precomputed: { context, response: response(source, type) } })
      )
      const result = evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, context)
      expect(result).toMatchObject({ value: expected, reason: 'TARGETING_MATCH', variant: 'variant' })
      expect(result.errorCode).toBeUndefined()
    })
  }
)

describe.each([
  ['precomputed', configurationFromPrecomputedString, configurationToPrecomputedString],
  ['rules-capable', configurationFromString, configurationToString],
] as const)('%s exact integer serialization', (_name, decode, encode) => {
  it.each([2 ** 60, 2 ** 67, 2 ** 100, -(2 ** 63)])('round-trips %s with plaintext and encoded keys', (expected) => {
    const source = BigInt(expected).toString()
    for (const obfuscated of [false, true]) {
      const lookup = encodePrecomputedFlagKey('probe', encoding)
      if ('error' in lookup) throw new Error(lookup.error)
      const raw = response(source, 'number', obfuscated ? lookup.key : 'probe', obfuscated).replace(
        /,"healthy":\{[^}]+\}/,
        ''
      )
      let configuration = decode(
        JSON.stringify({ version: obfuscated ? 2 : 1, precomputed: { context, response: raw } })
      )
      for (let round = 0; round < 3; round++) {
        expect(evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, context)).toMatchObject({
          value: expected,
          reason: 'TARGETING_MATCH',
          variant: 'variant',
        })
        const wire = encode(configuration)
        expect(JSON.parse(wire).precomputed.response).toContain(`"variationValue":${source}`)
        configuration = decode(wire)
      }
    }
  })
})

it('serializes application-created large numeric assignments without changing unrelated JSON values', () => {
  const value = 2 ** 60
  const parsed = JSON.parse(response('1', 'number'))
  parsed.data.attributes.flags.probe.variationValue = value
  parsed.data.attributes.flags.object = {
    ...parsed.data.attributes.flags.probe,
    variationType: 'object',
    variationValue: { nested: value },
  }
  const serialized = stringifyPrecomputedConfigurationJson(parsed)
  expect(serialized).toContain(`"variationValue":${BigInt(value)}`)
  expect(serialized).toContain(`"nested":${JSON.stringify(value)}`)
  expect(JSON.parse(serialized)).toEqual(parsed)
})

it.each(invalid)('preserves %s with the rules-capable codec and hashed flag keys', (source) => {
  const encoded = encodePrecomputedFlagKey('probe', encoding)
  if ('error' in encoded) throw new Error(encoded.error)
  // Keep the original numeric token instead of JSON.stringify's rounded value.
  const raw = response(source, 'number', encoded.key, true).replace(/,"healthy":\{[^}]+\}/, '')
  const configuration = configurationFromString(JSON.stringify({ version: 2, precomputed: { context, response: raw } }))
  const restored = configurationFromString(configurationToString(configuration))
  expect(evaluatePrecomputedConfiguration(restored, 'number', 'probe', -99.5, context)).toMatchObject({
    value: -99.5,
    reason: 'ERROR',
    errorCode: 'TYPE_MISMATCH',
  })
})

it('retains ordinary JSON behavior outside numeric assignments, including duplicate and special keys', () => {
  const raw =
    '{"__proto__":{"polluted":true},"duplicate":1e999,"duplicate":2,"nested":[9007199254740993,1e-999],"quoted":"variationValue: 1e999"}'
  expect(parsePrecomputedConfigurationJson(raw)).toEqual(JSON.parse(raw))
  expect(Object.getPrototypeOf(parsePrecomputedConfigurationJson(raw))).toBe(Object.prototype)
  expect({}).not.toHaveProperty('polluted')
})

it('does not recognize a JSON object as an internal numeric token', () => {
  const parsed = parsePrecomputedConfigurationResponse(
    parsePrecomputedConfigurationJson(response('{"isLosslessNumber":true,"value":"1e999"}', 'number'))
  )
  expect(parsed).toHaveProperty('flagErrors.probe', 'Invalid precomputed flag configuration')
})

it.each(['object', 'OBJECT', 'JSON'])('leaves ordinary JSON number conversion unchanged for %s flags', (type) => {
  const configuration = configurationFromPrecomputedString(
    JSON.stringify({ version: 1, precomputed: { response: response('{"nested":9007199254740993}', type) } })
  )
  expect(configuration.precomputed?.invalidNumericSources).toBeUndefined()
  expect(evaluatePrecomputedConfiguration(configuration, 'object', 'probe', {}, {})).toMatchObject({
    value: { nested: 9007199254740992 },
    reason: 'TARGETING_MATCH',
  })
})

it.each(['string', 'boolean', 'unknown'])(
  'does not classify a malformed %s flag as a numeric conversion failure',
  (type) => {
    const configuration = configurationFromPrecomputedString(
      JSON.stringify({ version: 1, precomputed: { response: response('1e999', type) } })
    )
    expect(configuration.precomputed?.invalidNumericSources).toBeUndefined()
    expect(configuration.precomputed?.flagErrors).toHaveProperty('probe')
  }
)

it('keeps rejected numeric assignments and their source map as plain cache-safe data', () => {
  const configuration = configurationFromPrecomputedString(
    JSON.stringify({ version: 1, precomputed: { response: response('1e999', 'number') } })
  )
  const flag = configuration.precomputed!.response.data.attributes.flags.probe
  expect(typeof flag.variationValue).toBe('number')
  expect(Object.getPrototypeOf(flag)).toBe(Object.prototype)
  expect(configuration.precomputed!.invalidNumericSources).toEqual({ probe: '1e999' })
  expect(Object.getPrototypeOf(configuration.precomputed!.invalidNumericSources)).toBe(Object.prototype)
  expect(structuredClone(configuration)).toEqual(configuration)
})

it.each(['01', '1.', '1e', '+1', 'NaN', 'Infinity'])('rejects malformed JSON number %s', (source) => {
  expect(() => parsePrecomputedConfigurationJson(response(source, 'number'))).toThrow()
})

it('normalizes optional consent metadata without losing invalid numeric tokens', () => {
  const raw = response('1e999', 'number').replace('"flags":', '"observeFullEvaluationData":"yes","flags":')
  const parsed = parsePrecomputedConfigurationResponse(parsePrecomputedConfigurationJson(raw))
  if ('error' in parsed) throw new Error(parsed.error)
  expect(parsed.response.data.attributes.observeFullEvaluationData).toBe(false)
  expect(stringifyPrecomputedConfigurationJson(parsed.response, parsed.invalidNumericSources)).toContain(
    '"variationValue":1e999'
  )
})

it('handles large exact and inexact integers without BigInt support', () => {
  const original = globalThis.BigInt
  const controls = [2 ** 100, -(2 ** 100), 2 ** 500, Number.MAX_VALUE].map(
    (value) => [original(value).toString(), value] as const
  )
  Object.defineProperty(globalThis, 'BigInt', { value: undefined, configurable: true, writable: true })
  try {
    for (const [source, expected] of controls) {
      const configuration = configurationFromPrecomputedString(
        JSON.stringify({ version: 1, precomputed: { response: response(source, 'number') } })
      )
      expect(evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, {})).toMatchObject({
        value: expected,
        reason: 'TARGETING_MATCH',
      })
      const restored = configurationFromPrecomputedString(configurationToPrecomputedString(configuration))
      expect(evaluatePrecomputedConfiguration(restored, 'number', 'probe', -99.5, {})).toMatchObject({
        value: expected,
        reason: 'TARGETING_MATCH',
      })
    }
    for (const source of invalid) {
      const configuration = configurationFromPrecomputedString(
        JSON.stringify({ version: 1, precomputed: { response: response(source, 'number') } })
      )
      expect(evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, {})).toMatchObject({
        value: -99.5,
        errorCode: 'TYPE_MISMATCH',
      })
    }
  } finally {
    Object.defineProperty(globalThis, 'BigInt', { value: original, configurable: true, writable: true })
  }
})
