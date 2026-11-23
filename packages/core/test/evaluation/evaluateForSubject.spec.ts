import type { EvaluationContext, Logger } from '@openfeature/core'
import {
  evaluateForSubject,
  evaluateRulesBasedConfiguration,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import type { TimeStamp } from '../../src/time'

describe('evaluateForSubject', () => {
  let logger: Logger

  beforeEach(() => {
    logger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }
  })

  it('should include evaluation entry timestamp in flagMetadata', () => {
    const evaluationTimestampMs = new Date('2026-06-22T12:34:56.789Z').getTime()
    jest.useFakeTimers()
    jest.setSystemTime(evaluationTimestampMs)

    try {
      const flag: Flag = {
        key: 'timestamped-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          'on-variation': { key: 'on-variation', value: true },
        },
        allocations: [
          {
            key: 'timestamped-allocation',
            doLog: true,
            splits: [
              {
                variationKey: 'on-variation',
                shards: [
                  {
                    salt: 'test-salt',
                    ranges: [{ start: 0, end: 10000 }],
                    totalShards: 10000,
                  },
                ],
              },
            ],
          },
        ],
      }

      const context: EvaluationContext = { targetingKey: 'user-123' }
      const result = evaluateForSubject(flag, 'boolean', 'user-123', context, false, logger)

      expect(result.value).toBe(true)
      expect(result.flagMetadata?.__dd_eval_timestamp_ms).toBe(evaluationTimestampMs)
    } finally {
      jest.useRealTimers()
    }
  })

  describe('__dd_split_serial_id passthrough', () => {
    it('should pass through serialId from split to flagMetadata.__dd_split_serial_id', () => {
      const serialId = 12345
      const flag: Flag = {
        key: 'test-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          'on-variation': { key: 'on-variation', value: true },
        },
        allocations: [
          {
            key: 'test-allocation',
            doLog: true,
            splits: [
              {
                variationKey: 'on-variation',
                serialId,
                shards: [
                  {
                    salt: 'test-salt',
                    ranges: [{ start: 0, end: 10000 }],
                    totalShards: 10000,
                  },
                ],
              },
            ],
          },
        ],
      }

      const context: EvaluationContext = { targetingKey: 'user-123' }
      const result = evaluateForSubject(flag, 'boolean', 'user-123', context, false, logger)

      expect(result.value).toBe(true)
      expect(result.reason).toBe('SPLIT')
      expect(result.flagMetadata?.__dd_split_serial_id).toBe(serialId)
    })

    it('should set __dd_split_serial_id to undefined when split has no serialId', () => {
      const flag: Flag = {
        key: 'test-flag',
        enabled: true,
        variationType: 'STRING',
        variations: {
          'variant-a': { key: 'variant-a', value: 'value-a' },
        },
        allocations: [
          {
            key: 'default-allocation',
            doLog: false,
            splits: [
              {
                variationKey: 'variant-a',
                // No serialId
                shards: [
                  {
                    salt: 'test-salt',
                    ranges: [{ start: 0, end: 10000 }],
                    totalShards: 10000,
                  },
                ],
              },
            ],
          },
        ],
      }

      const context: EvaluationContext = { targetingKey: 'user-456' }
      const result = evaluateForSubject(flag, 'string', 'user-456', context, 'default', logger)

      expect(result.value).toBe('value-a')
      expect(result.reason).toBe('SPLIT')
      expect(result.flagMetadata?.__dd_split_serial_id).toBeUndefined()
    })

    it('should pass through serialId with other flagMetadata fields', () => {
      const serialId = 99999
      const flag: Flag = {
        key: 'experiment-flag',
        enabled: true,
        variationType: 'INTEGER',
        variations: {
          control: { key: 'control', value: 0 },
          treatment: { key: 'treatment', value: 1 },
        },
        allocations: [
          {
            key: 'experiment-allocation',
            doLog: true,
            splits: [
              {
                variationKey: 'treatment',
                serialId,
                shards: [
                  {
                    salt: 'experiment-salt',
                    ranges: [{ start: 0, end: 10000 }],
                    totalShards: 10000,
                  },
                ],
              },
            ],
          },
        ],
      }

      const context: EvaluationContext = { targetingKey: 'user-789' }
      const result = evaluateForSubject(flag, 'number', 'user-789', context, -1, logger)

      expect(result.value).toBe(1)
      expect(result.variant).toBe('treatment')
      expect(result.flagMetadata).toMatchObject({
        __dd_allocation_key: 'experiment-allocation',
        __dd_do_log: true,
        __dd_split_serial_id: serialId,
        // Also verify deprecated keys are still set for backwards compatibility
        allocationKey: 'experiment-allocation',
        doLog: true,
      })
    })
  })

  describe('disabled flag', () => {
    it('should return default value when flag is disabled', () => {
      const flag: Flag = {
        key: 'disabled-flag',
        enabled: false,
        variationType: 'BOOLEAN',
        variations: {
          on: { key: 'on', value: true },
        },
        allocations: [],
      }

      const context: EvaluationContext = { targetingKey: 'user-123' }
      const evaluationTimestampMs = new Date('2026-06-22T12:34:56.789Z').getTime() as TimeStamp
      const result = evaluateForSubject(flag, 'boolean', 'user-123', context, false, logger, evaluationTimestampMs)

      expect(result.value).toBe(false)
      expect(result.reason).toBe('DISABLED')
      expect(result.flagMetadata?.__dd_eval_timestamp_ms).toBe(evaluationTimestampMs)
      expect(result.variant).toBeUndefined()
      expect(result.flagMetadata?.allocationKey).toBeUndefined()
    })
  })

  describe('malformed flag configuration', () => {
    it('returns a parse error for a present null flag definition', () => {
      const config = {
        createdAt: '2026-08-19T00:00:00Z',
        format: 'SERVER',
        environment: { name: 'test' },
        flags: { malformed: null },
      } as unknown as UniversalFlagConfigurationV1

      const result = evaluateRulesBasedConfiguration(
        config,
        'string',
        'malformed',
        'default',
        { targetingKey: 'user-123' },
        logger
      )

      expect(result).toMatchObject({
        value: 'default',
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
      })
    })

    it('rejects an array used as the variations map', () => {
      const flag = {
        key: 'array-variations',
        enabled: true,
        variationType: 'STRING',
        variations: [],
        allocations: [],
      } as unknown as Flag

      const result = evaluateForSubject(flag, 'string', 'user-123', {}, 'default', logger)

      expect(result).toMatchObject({
        value: 'default',
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
      })
    })

    it('rejects split variation keys inherited from Object.prototype', () => {
      const flag: Flag = {
        key: 'inherited-variation',
        enabled: true,
        variationType: 'STRING',
        variations: {},
        allocations: [
          {
            key: 'allocation',
            doLog: false,
            splits: [{ variationKey: 'constructor', shards: [] }],
          },
        ],
      }

      const result = evaluateForSubject(flag, 'string', 'user-123', {}, 'default', logger)

      expect(result).toMatchObject({
        value: 'default',
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
      })
    })
  })

  describe('type mismatch', () => {
    it('should return error when requested type does not match flag type', () => {
      const flag: Flag = {
        key: 'boolean-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          on: { key: 'on', value: true },
        },
        allocations: [
          {
            key: 'default',
            doLog: false,
            splits: [
              {
                variationKey: 'on',
                shards: [{ salt: 's', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
              },
            ],
          },
        ],
      }

      const context: EvaluationContext = { targetingKey: 'user-123' }
      const evaluationTimestampMs = new Date('2026-06-22T12:34:56.789Z').getTime() as TimeStamp
      const result = evaluateForSubject(flag, 'string', 'user-123', context, 'default', logger, evaluationTimestampMs)

      expect(result.value).toBe('default')
      expect(result.reason).toBe('ERROR')
      expect(result.errorCode).toBe('TYPE_MISMATCH')
      expect(result.flagMetadata?.__dd_eval_timestamp_ms).toBe(evaluationTimestampMs)
      expect(result.variant).toBeUndefined()
      expect(result.flagMetadata?.allocationKey).toBeUndefined()
    })
  })

  describe('targetingKey in targeting rules', () => {
    const conditionFlag = (
      key: string,
      attribute: string,
      value: string[] | string | boolean,
      operator = 'ONE_OF'
    ): Flag =>
      ({
        key,
        enabled: true,
        variationType: 'STRING',
        variations: { on: { key: 'on', value: 'on' } },
        allocations: [
          {
            key: 'match',
            doLog: false,
            rules: [{ conditions: [{ operator, attribute, value }] }],
            splits: [{ variationKey: 'on', shards: [] }],
          },
        ],
      }) as unknown as Flag

    const config = {
      createdAt: '2026-11-16T00:00:00Z',
      format: 'SERVER',
      environment: { name: 'test' },
      flags: {
        'targeting-key-equals': conditionFlag('targeting-key-equals', 'targetingKey', ['foo']),
        'targeting-key-one-of': conditionFlag('targeting-key-one-of', 'targetingKey', ['foo', 'baz']),
        'id-equals': conditionFlag('id-equals', 'id', ['foo']),
        'targeting-key-not-one-of': conditionFlag('targeting-key-not-one-of', 'targetingKey', ['foo'], 'NOT_ONE_OF'),
        'targeting-key-is-null': conditionFlag('targeting-key-is-null', 'targetingKey', true, 'IS_NULL'),
        'targeting-key-matches': conditionFlag('targeting-key-matches', 'targetingKey', '^f', 'MATCHES'),
      },
    } as unknown as UniversalFlagConfigurationV1

    const evaluate = (flagKey: string, context: EvaluationContext) =>
      evaluateRulesBasedConfiguration(config, 'string', flagKey, 'default', context, logger)

    it('matches a targetingKey rule against the context targeting key', () => {
      expect(evaluate('targeting-key-equals', { targetingKey: 'foo' }).value).toBe('on')
    })

    it('does not match a targetingKey rule when the targeting key differs', () => {
      expect(evaluate('targeting-key-equals', { targetingKey: 'bar' }).value).toBe('default')
    })

    it('does not match or error when the targeting key is missing', () => {
      const result = evaluate('targeting-key-equals', {})
      expect(result.value).toBe('default')
      expect(result.errorCode).toBeUndefined()
    })

    it('still matches an id rule against the context targeting key', () => {
      expect(evaluate('id-equals', { targetingKey: 'foo' }).value).toBe('on')
    })

    it('matches a targetingKey ONE_OF rule', () => {
      expect(evaluate('targeting-key-one-of', { targetingKey: 'baz' }).value).toBe('on')
    })

    it.each([
      ['targeting-key-not-one-of', { targetingKey: 'bar' }, 'on'],
      ['targeting-key-not-one-of', { targetingKey: 'foo' }, 'default'],
      ['targeting-key-not-one-of', {}, 'default'],
      ['targeting-key-is-null', { targetingKey: 'foo' }, 'default'],
      ['targeting-key-is-null', {}, 'on'],
      ['targeting-key-matches', { targetingKey: 'foo' }, 'on'],
      ['targeting-key-matches', {}, 'default'],
    ] as const)('resolves %s against the context targeting key %#', (flagKey, context, expected) => {
      expect(evaluate(flagKey, context).value).toBe(expected)
    })

    it('lets an explicit id attribute override the targeting key', () => {
      expect(evaluate('id-equals', { targetingKey: 'foo', id: 'bar' }).value).toBe('default')
    })
  })
})
