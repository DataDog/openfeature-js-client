import type { FlagsConfiguration } from './configuration'
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
              extraLogging: { experiment: 'true' },
            },
          },
        },
      },
    },
    context: { targetingKey: 'user-1', country: 'US' },
  },
}

const rulesResponse = 'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADKgJvbg=='

describe('configuration wire', () => {
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
  ])('rejects serializing a %s configuration instead of silently dropping rules', (_, includePrecomputed) => {
    const rules = configurationFromString(
      JSON.stringify({ version: 1, rules: { response: rulesResponse, etag: 'rules-etag' } })
    )
    const configurationWithRules: FlagsConfiguration = {
      ...(includePrecomputed ? configuration : {}),
      rules: rules.rules,
    }

    expect(() => configurationToString(configurationWithRules)).toThrow(
      'Rules configurations cannot be serialized to the wire format'
    )
  })

  it('returns an empty configuration for an unknown version', () => {
    expect(configurationFromString(JSON.stringify({ version: 2 }))).toEqual({})
  })

  it('returns an empty configuration for malformed input', () => {
    expect(configurationFromString('not json')).toEqual({})
    expect(configurationFromString('null')).toEqual({})
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
    expect(restored.rules?.response.flags['browser-flag']).toBeDefined()
  })

  it.each([{}, { data: {} }, { data: { attributes: { createdAt: 0, flags: [] } } }])(
    'rejects a structurally invalid precomputed response',
    (response) => {
      const wire = { version: 1, precomputed: { response: JSON.stringify(response) } }

      expect(configurationFromString(JSON.stringify(wire))).toEqual({})
    }
  )

  it.each([
    ['BOOLEAN', 'true'],
    ['STRING', false],
    ['NUMBER', Number.NaN],
    ['OBJECT', null],
  ])('rejects precomputed %s flags with an invalid value', (variationType, variationValue) => {
    const response = {
      data: {
        attributes: {
          createdAt: 0,
          flags: {
            flag: {
              allocationKey: 'allocation',
              variationKey: 'variation',
              variationType,
              variationValue,
              reason: 'STATIC',
              doLog: false,
              extraLogging: {},
            },
          },
        },
      },
    }
    const wire = { version: 1, precomputed: { response: JSON.stringify(response) } }

    expect(configurationFromString(JSON.stringify(wire))).toEqual({})
  })

  it('rejects precomputed flags with non-string extra logging values', () => {
    const response = JSON.parse(JSON.stringify(configuration.precomputed?.response))
    response.data.attributes.flags['my-flag'].extraLogging = { experiment: true }
    const wire = { version: 1, precomputed: { response: JSON.stringify(response) } }

    expect(configurationFromString(JSON.stringify(wire))).toEqual({})
  })

  it.each([
    null,
    [],
    { response: 42 },
    { response: '{}', context: [] },
    { response: '{}', context: { targetingKey: 42 } },
    { response: '{}', fetchedAt: 'now' },
    { response: '{}', etag: 42 },
  ])('omits an invalid precomputed wire entry independently', (precomputed) => {
    const restored = configurationFromString(
      JSON.stringify({ version: 1, precomputed, rules: { response: rulesResponse } })
    )

    expect(restored.precomputed).toBeUndefined()
    expect(restored.rules).toBeDefined()
  })

  it('omits an invalid rules wire entry independently', () => {
    const precomputed = JSON.parse(configurationToString(configuration)).precomputed
    const restored = configurationFromString(
      JSON.stringify({ version: 1, precomputed, rules: { response: 42, fetchedAt: 'now' } })
    )

    expect(restored.precomputed).toEqual(configuration.precomputed)
    expect(restored.rules).toBeUndefined()
  })
})
