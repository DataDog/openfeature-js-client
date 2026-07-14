import type { EvaluationContext, Logger } from '@openfeature/core'
import { evaluateForSubject, type Flag } from '../../src/evaluation'
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
                extraLogging: { campaign: 'summer' },
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
      expect(result.flagMetadata).not.toHaveProperty('extraLogging')
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
})
