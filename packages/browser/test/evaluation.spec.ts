import { evaluate, type FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/rules-based'
import type { ErrorCode } from '@openfeature/web-sdk'
import configurationWire from './data/precomputed-v1-wire.json'
import rulesWire from './data/rules-v1-wire.json'

const configuration = configurationFromString(
  // Adding stringify because import has parsed JSON
  JSON.stringify(configurationWire)
)
const matchingContext = configuration.precomputed?.context ?? {}

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))

const matrixContext = { targetingKey: 'user-1', country: 'US' }
const matrixPrecomputedConfiguration: FlagsConfiguration = {
  precomputed: {
    context: matrixContext,
    response: {
      data: {
        attributes: {
          createdAt: '2026-08-06T00:00:00.000Z',
          flags: {
            'test-flag': {
              allocationKey: 'precomputed-allocation',
              variationKey: 'precomputed-off',
              variationType: 'boolean',
              variationValue: false,
              reason: 'STATIC',
              doLog: false,
            },
          },
        },
      },
    },
  },
}

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
    const result = evaluate(undefined, 'boolean', 'boolean-flag', true, {})
    expect(result).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
      errorMessage: 'No flags configuration has been set',
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

  describe('serial id', () => {
    const configurationWithSerialId = (serialId?: number | null): FlagsConfiguration => ({
      precomputed: {
        response: {
          data: {
            attributes: {
              createdAt: '2026-08-17T00:00:00.000Z',
              flags: {
                'string-flag': {
                  allocationKey: 'allocation-123',
                  variationKey: 'variation-123',
                  variationType: 'string',
                  variationValue: 'red',
                  reason: 'TARGETING_MATCH',
                  doLog: true,
                  ...(serialId === undefined ? {} : { serialId }),
                },
              },
            },
          },
        },
      },
    })

    it('carries the serial id from the precomputed flag onto the evaluation metadata', () => {
      const result = evaluate(configurationWithSerialId(340132), 'string', 'string-flag', 'default', {})
      expect(result.flagMetadata).toEqual({
        allocationKey: 'allocation-123',
        variationType: 'string',
        doLog: true,
        __dd_split_serial_id: 340132,
      })
    })

    it('omits the serial id when the server sends null', () => {
      const result = evaluate(configurationWithSerialId(null), 'string', 'string-flag', 'default', {})
      expect(result.flagMetadata).not.toHaveProperty('__dd_split_serial_id')
      expect(result.value).toBe('red')
    })

    it('omits the serial id when the server sends no such key', () => {
      const result = evaluate(configurationWithSerialId(), 'string', 'string-flag', 'default', {})
      expect(result.flagMetadata).not.toHaveProperty('__dd_split_serial_id')
      expect(result.value).toBe('red')
    })
  })

  it('does not use precomputed configuration when context does not match', () => {
    const result = evaluate(configuration, 'string', 'string-flag', 'default', { targetingKey: 'other-user' })

    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
      errorMessage: 'Precomputed flags configuration does not match the current context',
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

  describe('combined capability validity matrix', () => {
    it('prefers valid matching precomputed data over valid rules', () => {
      const result = evaluate(
        { ...matrixPrecomputedConfiguration, rules: rulesConfiguration.rules },
        'boolean',
        'test-flag',
        true,
        matrixContext
      )

      expect(result).toMatchObject({
        value: false,
        variant: 'precomputed-off',
        reason: 'STATIC',
      })
    })

    it('uses valid rules when valid precomputed data does not match', () => {
      const result = evaluate(
        { ...matrixPrecomputedConfiguration, rules: rulesConfiguration.rules },
        'boolean',
        'test-flag',
        false,
        { targetingKey: 'other-user', country: 'US' }
      )

      expect(result).toMatchObject({
        value: true,
        variant: 'on',
        reason: 'TARGETING_MATCH',
      })
    })

    it('uses valid rules when precomputed data is invalid', () => {
      const result = evaluate(
        { precomputedError: 'Malformed precomputed data', rules: rulesConfiguration.rules },
        'boolean',
        'test-flag',
        false,
        matrixContext
      )

      expect(result).toMatchObject({
        value: true,
        variant: 'on',
        reason: 'TARGETING_MATCH',
      })
    })

    it.each([undefined, 'Malformed rules data'])('uses valid matching precomputed data when rules error is %s', (rulesError) => {
      expect(
        evaluate({ ...matrixPrecomputedConfiguration, rulesError }, 'boolean', 'test-flag', true, matrixContext)
      ).toMatchObject({
        value: false,
        variant: 'precomputed-off',
        reason: 'STATIC',
      })
    })

    it('returns a configuration error when precomputed data is invalid and rules are invalid or absent', () => {
      expect(
        evaluate({ precomputedError: 'Malformed precomputed data' }, 'boolean', 'test-flag', false, matrixContext)
      ).toEqual({
        value: false,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
        errorMessage: 'Malformed precomputed data',
      })
    })

    it('returns provider not ready when both capabilities are absent', () => {
      expect(evaluate(undefined, 'boolean', 'test-flag', false, matrixContext)).toEqual({
        value: false,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        errorMessage: 'No flags configuration has been set',
      })
    })

    it.each([
      [{ rulesError: 'Malformed rules data' }, 'Malformed rules data'],
      [{ configurationError: 'Malformed configuration envelope' }, 'Malformed configuration envelope'],
      [{}, 'Flags configuration contains no usable capability'],
    ] as const)('returns a parse error for unusable configured data', (configured, errorMessage) => {
      expect(evaluate(configured, 'boolean', 'test-flag', false, matrixContext)).toEqual({
        value: false,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
        errorMessage,
      })
    })

    it('returns a rules parse error when mismatched precomputed data cannot fall back to rules', () => {
      expect(
        evaluate(
          { ...matrixPrecomputedConfiguration, rulesError: 'Malformed rules data' },
          'boolean',
          'test-flag',
          false,
          { targetingKey: 'other-user' }
        )
      ).toEqual({
        value: false,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
        errorMessage: 'Malformed rules data',
      })
    })
  })
})
