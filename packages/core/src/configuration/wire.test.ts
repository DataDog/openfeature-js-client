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
              extraLogging: {},
            },
          },
        },
      },
    },
    context: { targetingKey: 'user-1', country: 'US' },
  },
}

describe('configuration wire', () => {
  it('round-trips a precomputed configuration', () => {
    const restored = configurationFromString(configurationToString(configuration))

    expect(restored).toEqual(configuration)
  })

  it('keeps flags readable after a round-trip', () => {
    const restored = configurationFromString(configurationToString(configuration))

    expect(restored.precomputed?.response.data.attributes.flags['my-flag'].variationValue).toBe(
      true,
    )
  })

  it('serializes precomputed.response as a stringified response object, not the whole precomputed', () => {
    const wire = JSON.parse(configurationToString(configuration))

    // `precomputed.response` on the wire must be the response only, so parsing it yields
    // the response object (regression guard: it previously stringified the whole
    // precomputed object, double-nesting the response and losing the flags).
    expect(JSON.parse(wire.precomputed.response)).toEqual(configuration.precomputed?.response)
  })

  it('returns an empty configuration for an unknown version', () => {
    expect(configurationFromString(JSON.stringify({ version: 2 }))).toEqual({})
  })

  it('returns an empty configuration for malformed input', () => {
    expect(configurationFromString('not json')).toEqual({})
  })
})
