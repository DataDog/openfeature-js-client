import { evaluate } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/configuration'
import type { ErrorCode } from '@openfeature/web-sdk'
import configurationWire from './data/precomputed-v1-wire.json'
import rulesWire from './data/rules-v1-wire.json'

const configuration = configurationFromString(
  // Adding stringify because import has parsed JSON
  JSON.stringify(configurationWire)
)
const matchingContext = configuration.precomputed?.context ?? {}

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))

const configurationWithMalformedFlag = configurationFromString(
  JSON.stringify({
    version: 1,
    precomputed: {
      response: JSON.stringify({
        data: {
          attributes: {
            createdAt: 0,
            flags: {
              valid: {
                allocationKey: 'allocation',
                variationKey: 'valid-variation',
                variationType: 'BOOLEAN',
                variationValue: true,
                reason: 'STATIC',
                doLog: false,
              },
              malformed: {
                allocationKey: 'allocation',
                variationKey: 'malformed-variation',
                variationType: 'BOOLEAN',
                variationValue: 'not-a-boolean',
                reason: 'STATIC',
                doLog: false,
              },
            },
          },
        },
      }),
    },
  })
)

const configurationWithMalformedResponse = configurationFromString(
  JSON.stringify({
    version: 1,
    precomputed: {
      response: JSON.stringify({ data: {} }),
    },
  })
)

describe('evaluate', () => {
  it('returns default for missing configuration', () => {
    const result = evaluate({}, 'boolean', 'boolean-flag', true, {})
    expect(result).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
    })
  })

  it('returns default for unknown flag', () => {
    const result = evaluate(configuration, 'string', 'unknown-flag', 'default', matchingContext)
    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
    })
  })

  it.each(['constructor', '__proto__'])('treats inherited precomputed flag key %s as missing', (flagKey) => {
    expect(evaluate(configuration, 'string', flagKey, 'default', matchingContext)).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
    })
  })

  it('isolates malformed precomputed flags and returns a parse error for the affected flag', () => {
    expect(evaluate(configurationWithMalformedFlag, 'boolean', 'valid', false, {})).toMatchObject({
      value: true,
      variant: 'valid-variation',
      reason: 'STATIC',
    })
    expect(evaluate(configurationWithMalformedFlag, 'boolean', 'malformed', false, {})).toEqual({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: 'Invalid precomputed flag configuration',
    })
  })

  it('returns a parse error for a malformed precomputed response', () => {
    expect(evaluate(configurationWithMalformedResponse, 'boolean', 'flag', false, {})).toEqual({
      value: false,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: 'Precomputed configuration response is missing attributes',
    })
  })

  it('returns default without variant metadata for type mismatch', () => {
    const result = evaluate(configuration, 'string', 'boolean-flag', 'default', matchingContext)
    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH' as ErrorCode,
    })
    expect(result).not.toHaveProperty('variant')
    expect(result).not.toHaveProperty('flagMetadata')
  })

  it('resolves boolean flag', () => {
    const result = evaluate(configuration, 'boolean', 'boolean-flag', true, matchingContext)
    expect(result).toEqual({
      value: true,
      variant: 'variation-124',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-124',
        doLog: true,
        variationType: 'BOOLEAN',
      },
    })
  })

  it('resolves string flag', () => {
    const result = evaluate(configuration, 'string', 'string-flag', 'default', matchingContext)
    expect(result).toEqual({
      value: 'red',
      variant: 'variation-123',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
        doLog: true,
        variationType: 'STRING',
      },
    })
  })

  it('resolves object flag', () => {
    const result = evaluate<'object'>(configuration, 'object', 'json-flag', { hello: 'world' }, matchingContext)
    expect(result).toEqual({
      value: { key: 'value', prop: 123 },
      variant: 'variation-127',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-127',
        doLog: true,
        variationType: 'OBJECT',
      },
    })
  })

  it('does not use precomputed configuration when context does not match', () => {
    const result = evaluate(configuration, 'string', 'string-flag', 'default', { targetingKey: 'other-user' })

    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
    })
  })

  it('evaluates rules-based configuration when present', () => {
    const result = evaluate(rulesConfiguration, 'boolean', 'test-flag', false, {
      targetingKey: 'user-1',
      country: 'US',
    })

    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation',
        doLog: true,
      },
    })
  })

  it('falls back to rules-based configuration when precomputed context does not match', () => {
    const result = evaluate(
      {
        ...rulesConfiguration,
        precomputed: configuration.precomputed,
      },
      'boolean',
      'test-flag',
      false,
      { targetingKey: 'other-user', country: 'CA' }
    )

    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'SPLIT',
      flagMetadata: {
        allocationKey: 'fallback',
        doLog: false,
      },
    })
  })
})
