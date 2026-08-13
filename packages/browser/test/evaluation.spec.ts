import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/configuration'
import type { ErrorCode } from '@openfeature/web-sdk'
import { evaluate } from '../src/evaluation'
import configurationWire from './data/precomputed-v1-wire.json'

const configuration = configurationFromString(
  // Adding stringify because import has parsed JSON
  JSON.stringify(configurationWire)
)

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
      reason: 'DEFAULT',
    })
  })

  it('returns default for unknown flag', () => {
    const result = evaluate(configuration, 'string', 'unknown-flag', 'default', {})
    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
    })
  })

  it.each(['constructor', '__proto__'])('treats inherited flag key %s as unknown', (flagKey) => {
    expect(evaluate(configuration, 'string', flagKey, 'default', {})).toEqual({
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
    const result = evaluate(configuration, 'string', 'boolean-flag', 'default', {})
    expect(result).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH' as ErrorCode,
    })
    expect(result).not.toHaveProperty('variant')
    expect(result).not.toHaveProperty('flagMetadata')
  })

  it('resolves boolean flag', () => {
    const result = evaluate(configuration, 'boolean', 'boolean-flag', true, {})
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
    const result = evaluate(configuration, 'string', 'string-flag', 'default', {})
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
    const result = evaluate<'object'>(configuration, 'object', 'json-flag', { hello: 'world' }, {})
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
})
