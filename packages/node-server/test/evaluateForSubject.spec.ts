import type { EvaluationContext, Logger } from '@openfeature/core'
import { evaluateForSubject } from '../src/configuration/evaluateForSubject'
import type { Flag } from '../src/configuration/ufc-v1'

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

  describe('__dd_split_serial_id passthrough', () => {
    it('should pass through holdout extraLogging to flagMetadata', () => {
      const flag: Flag = {
        key: 'checkout-redesign',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          control: { key: 'control', value: false },
        },
        allocations: [
          {
            key: 'allocation-a-holdout-q2-global-holdout',
            doLog: true,
            splits: [
              {
                variationKey: 'control',
                extraLogging: {
                  holdoutKey: 'q2-global-holdout',
                  holdoutAnalysisExperimentId: 'holdout-analysis-experiment-id',
                  holdoutVariation: 'status_quo',
                  holdoutBaseAllocationKey: 'allocation-a',
                },
                shards: [
                  {
                    salt: 'holdout-salt',
                    ranges: [{ start: 0, end: 10000 }],
                    totalShards: 10000,
                  },
                ],
              },
            ],
          },
        ],
      }

      const result = evaluateForSubject(flag, 'boolean', 'user-123', { id: 'user-123' }, true, logger)

      expect(result.value).toBe(false)
      expect(result.flagMetadata).toMatchObject({
        allocationKey: 'allocation-a-holdout-q2-global-holdout',
        __dd_holdout_key: 'q2-global-holdout',
        __dd_holdout_experiment_id: 'holdout-analysis-experiment-id',
        __dd_holdout_variation: 'status_quo',
        __dd_holdout_base_allocation_key: 'allocation-a',
      })
    })

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
      expect(result.reason).toBe('TARGETING_MATCH')
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
      expect(result.reason).toBe('TARGETING_MATCH')
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
      const result = evaluateForSubject(flag, 'boolean', 'user-123', context, false, logger)

      expect(result.value).toBe(false)
      expect(result.reason).toBe('DISABLED')
      expect(result.flagMetadata).toBeUndefined()
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
      const result = evaluateForSubject(flag, 'string', 'user-123', context, 'default', logger)

      expect(result.value).toBe('default')
      expect(result.reason).toBe('ERROR')
      expect(result.errorCode).toBe('TYPE_MISMATCH')
    })
  })
})
