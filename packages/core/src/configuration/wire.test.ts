import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire'
import type { FlagsConfiguration } from './configuration'
import { configurationFromPrecomputedString, configurationToPrecomputedString } from './precomputed-wire'
import { configurationFromRulesString } from './rules-wire'
import { configurationFromString, configurationToString } from './wire'

const configuration: FlagsConfiguration = {
  precomputed: {
    response: {
      data: {
        attributes: {
          createdAt: '2026-07-06T23:01:56.822Z',
          flags: {
            'my-flag': {
              allocationKey: 'alloc-1',
              variationKey: 'true',
              variationType: 'boolean',
              variationValue: true,
              reason: 'STATIC',
              doLog: true,
            },
          },
        },
      },
    },
    context: { targetingKey: 'user-1', country: 'US' },
  },
}

const rulesResponse = 'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADKgJvbg=='

function withUnknownField(response: string): string {
  const decoded = base64Decode(response)
  const encoded = new Uint8Array(decoded.length + 3)
  encoded.set(decoded)
  encoded.set([0xa0, 0x06, 0x07], decoded.length) // Unknown field 100 with varint value 7.
  return base64Encode(encoded)
}

describe('configuration wire', () => {
  it('parses precomputed configuration without parsing rules', () => {
    const precomputed = JSON.parse(configurationToString(configuration)).precomputed
    const wire = JSON.stringify({
      version: 1,
      precomputed,
      rules: { response: rulesResponse },
    })

    expect(configurationFromPrecomputedString(wire)).toEqual(configuration)
  })

  it('round-trips only the precomputed capability', () => {
    const wire = configurationToPrecomputedString(configuration)

    expect(configurationFromPrecomputedString(wire)).toEqual(configuration)
    expect(JSON.parse(wire).rules).toBeUndefined()
  })

  it('parses rules configuration without parsing precomputed data', () => {
    const wire = JSON.stringify({
      version: 1,
      precomputed: { response: JSON.stringify(configuration.precomputed?.response) },
      rules: { response: rulesResponse },
    })

    const restored = configurationFromRulesString(wire)
    expect(restored.precomputed).toBeUndefined()
    expect(restored.rules?.response.flags['browser-flag']).toBeDefined()
  })

  it('round-trips a precomputed configuration', () => {
    const restored = configurationFromString(configurationToString(configuration))

    expect(restored).toEqual(configuration)
  })

  it('keeps flags readable after a round-trip', () => {
    const restored = configurationFromString(configurationToString(configuration))

    expect(restored.precomputed?.response.data.attributes.flags['my-flag'].variationValue).toBe(true)
  })

  it('serializes only the precomputed response object', () => {
    const wire = JSON.parse(configurationToString(configuration))

    expect(JSON.parse(wire.precomputed.response)).toEqual(configuration.precomputed?.response)
  })

  it.each([
    ['rules-only', false],
    ['combined precomputed and rules', true],
  ])('round-trips a %s configuration', (_, includePrecomputed) => {
    const rules = configurationFromString(
      JSON.stringify({
        version: 1,
        rules: { response: rulesResponse, fetchedAt: 1731939819456, etag: 'rules-etag' },
      })
    )
    const configurationWithRules: FlagsConfiguration = {
      ...(includePrecomputed ? configuration : {}),
      rules: rules.rules,
    }

    expect(configurationFromString(configurationToString(configurationWithRules))).toEqual(configurationWithRules)
  })

  it('preserves unknown protobuf fields when rules are serialized', () => {
    const configurationWithUnknownField = configurationFromString(
      JSON.stringify({ version: 1, rules: { response: withUnknownField(rulesResponse) } })
    )

    const restored = configurationFromString(configurationToString(configurationWithUnknownField))
    const unknown = restored.rules?.response.$unknown
    expect(unknown).toHaveLength(1)
    expect(unknown?.[0]).toMatchObject({ no: 100, wireType: 0 })
    expect(Array.from(unknown?.[0]?.data ?? [])).toEqual([7])
  })

  it('retains a configuration error for an unknown version', () => {
    expect(configurationFromString(JSON.stringify({ version: 2 }))).toEqual({
      configurationError: 'Invalid flags configuration wire format',
    })
  })

  it('retains a configuration error for malformed input', () => {
    expect(configurationFromString('not json')).toEqual({
      configurationError: 'Invalid flags configuration wire format',
    })
    expect(configurationFromString('null')).toEqual({
      configurationError: 'Invalid flags configuration wire format',
    })
  })

  it('decodes a rules entry and preserves its wire metadata', () => {
    const restored = configurationFromString(
      JSON.stringify({
        version: 1,
        rules: {
          response: rulesResponse,
          fetchedAt: 1731939819456,
          etag: 'rules-etag',
        },
      })
    )

    expect(restored.rules).toMatchObject({
      fetchedAt: 1731939819456,
      etag: 'rules-etag',
    })
    expect(restored.rules?.response.flags['browser-flag']).toBeDefined()
  })

  it('keeps valid precomputed configuration when rules are malformed', () => {
    const wire = JSON.parse(configurationToString(configuration))
    wire.precomputed.etag = 'precomputed-etag'
    wire.rules = { response: 'not base64', etag: 'rules-etag' }

    expect(configurationFromString(JSON.stringify(wire))).toEqual({
      precomputed: { ...configuration.precomputed, etag: 'precomputed-etag' },
      rulesError: 'Rules configuration response could not be decoded',
    })
  })

  it('decodes precomputed and rules entries from the same wire value', () => {
    const precomputed = JSON.parse(configurationToString(configuration)).precomputed
    const restored = configurationFromString(
      JSON.stringify({
        version: 1,
        precomputed: { ...precomputed, etag: 'precomputed-etag' },
        rules: { response: rulesResponse, etag: 'rules-etag' },
      })
    )

    expect(restored.precomputed).toEqual({ ...configuration.precomputed, etag: 'precomputed-etag' })
    expect(restored.rules?.etag).toBe('rules-etag')
    expect(restored.rules?.response.flags['browser-flag']).toBeDefined()
  })

  it('keeps valid rules configuration when precomputed JSON is malformed', () => {
    const restored = configurationFromString(
      JSON.stringify({ version: 1, precomputed: { response: '{' }, rules: { response: rulesResponse } })
    )

    expect(restored.precomputed).toBeUndefined()
    expect(restored.precomputedError).toBe('Precomputed configuration response is not valid JSON')
    expect(restored.rules?.response.flags['browser-flag']).toBeDefined()
  })

  it.each([
    [null, 'Precomputed configuration response must be an object'],
    [{}, 'Precomputed configuration response is missing data'],
    [{ data: {} }, 'Precomputed configuration response is missing attributes'],
    [{ data: { attributes: { createdAt: null, flags: {} } } }, 'Precomputed configuration createdAt is invalid'],
    [{ data: { attributes: { createdAt: 0, flags: [] } } }, 'Precomputed configuration flags must be an object'],
  ])('retains a parse error for a structurally invalid precomputed response', (response, error) => {
    const wire = { version: 1, precomputed: { response: JSON.stringify(response) } }

    expect(configurationFromString(JSON.stringify(wire))).toEqual({ precomputedError: error })
  })

  it.each([
    ['BOOLEAN', 'true'],
    ['STRING', false],
    ['NUMBER', Number.NaN],
    ['OBJECT', null],
  ])('isolates a malformed precomputed %s flag', (variationType, variationValue) => {
    const validFlag = {
      allocationKey: 'allocation',
      variationKey: 'valid-variation',
      variationType: 'BOOLEAN',
      variationValue: true,
      reason: 'STATIC',
      doLog: false,
    }
    const response = {
      data: {
        attributes: {
          createdAt: 0,
          flags: {
            valid: validFlag,
            malformed: {
              allocationKey: 'allocation',
              variationKey: 'malformed-variation',
              variationType,
              variationValue,
              reason: 'STATIC',
              doLog: false,
            },
          },
        },
      },
    }
    const wire = { version: 1, precomputed: { response: JSON.stringify(response) } }
    const serializedResponse = JSON.parse(wire.precomputed.response)

    const parsed = configurationFromString(JSON.stringify(wire))

    expect(parsed).toEqual({
      precomputed: {
        response: serializedResponse,
        flagErrors: {
          malformed: 'Invalid precomputed flag configuration',
        },
      },
    })
    expect(configurationFromString(configurationToString(parsed))).toEqual(parsed)
  })

  it.each([
    null,
    [],
    { response: 42 },
    { response: '{}', context: [] },
    { response: '{}', context: { targetingKey: 42 } },
    { response: '{}', fetchedAt: 'now' },
    { response: '{}', etag: 42 },
  ])('retains an invalid precomputed wire entry error independently', (precomputed) => {
    const restored = configurationFromString(
      JSON.stringify({ version: 1, precomputed, rules: { response: rulesResponse } })
    )

    expect(restored.precomputed).toBeUndefined()
    expect(restored.precomputedError).toBe('Invalid precomputed configuration wire entry')
    expect(restored.rules).toBeDefined()
  })

  it('retains an invalid rules wire entry error independently', () => {
    const precomputed = JSON.parse(configurationToString(configuration)).precomputed
    const restored = configurationFromString(
      JSON.stringify({ version: 1, precomputed, rules: { response: 42, fetchedAt: 'now' } })
    )

    expect(restored.precomputed).toEqual(configuration.precomputed)
    expect(restored.rules).toBeUndefined()
    expect(restored.rulesError).toBe('Invalid rules configuration wire entry')
  })

  it.each([configurationFromPrecomputedString, configurationFromRulesString])(
    'retains an invalid wire error in capability-specific parsers',
    (parse) => {
      expect(parse('not json')).toEqual({ configurationError: 'Invalid flags configuration wire format' })
    }
  )
})
