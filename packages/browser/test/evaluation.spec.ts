import { configurationFromString } from '@datadog/flagging-core'
import type { ErrorCode } from '@openfeature/web-sdk'
import { evaluate } from '../src/evaluation'
import configurationWire from './data/precomputed-v1-wire.json'

const configuration = configurationFromString(
  // Adding stringify because import has parsed JSON
  JSON.stringify(configurationWire)
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

  it('passes holdout metadata through precomputed flag metadata', () => {
    const result = evaluate(
      {
        precomputed: {
          response: {
            data: {
              attributes: {
                createdAt: '2026-06-02T00:00:00.000Z',
                flags: {
                  'checkout-redesign': {
                    allocationKey: 'allocation-a-holdout-q2-global-holdout',
                    variationKey: 'control',
                    variationType: 'boolean',
                    variationValue: false,
                    reason: 'TARGETING_MATCH',
                    doLog: true,
                    extraLogging: {},
                    holdout: {
                      key: 'q2-global-holdout',
                      variation: 'status_quo',
                    },
                  },
                },
              },
            },
          },
        },
      },
      'boolean',
      'checkout-redesign',
      true,
      {}
    )

    expect(result.flagMetadata).toMatchObject({
      allocationKey: 'allocation-a-holdout-q2-global-holdout',
      __dd_holdout_key: 'q2-global-holdout',
      __dd_holdout_variation: 'status_quo',
    })
  })
})
