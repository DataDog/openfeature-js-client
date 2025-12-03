import type { EvaluationContext, EvaluationDetails } from '@openfeature/core'
import { FlagEvaluationAggregator } from '../../src/configuration/flagEvaluationAggregator'

describe('FlagEvaluationAggregator', () => {
  let aggregator: FlagEvaluationAggregator
  let onFlushSpy: jest.Mock

  beforeEach(() => {
    onFlushSpy = jest.fn()
    aggregator = new FlagEvaluationAggregator(100, onFlushSpy)
    jest.useFakeTimers()
  })

  afterEach(() => {
    aggregator.stop()
    jest.useRealTimers()
  })

  it('should aggregate evaluations by key', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }
    const mockDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    aggregator.addEvaluation(mockContext, mockDetails)
    aggregator.addEvaluation(mockContext, mockDetails)

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        flag: { key: 'test-flag' },
        evaluation_count: 2,
        runtime_default_used: false,
        variant: { key: 'variant-a' },
        allocation: { key: 'allocation-123' },
        targeting_key: 'user123',
        timestamp: expect.any(Number),
      }),
    ])
  })

  it('should track runtime default usage', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }
    const mockDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: false,
      reason: 'DEFAULT',
      flagMetadata: {},
    }

    aggregator.addEvaluation(mockContext, mockDetails)

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        flag: { key: 'test-flag' },
        evaluation_count: 1,
        runtime_default_used: true,
        targeting_key: 'user123',
        timestamp: expect.any(Number),
      }),
    ])
  })

  it('should handle errors', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }
    const mockDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: false,
      reason: 'ERROR',
      flagMetadata: {},
    }

    aggregator.addEvaluation(mockContext, mockDetails, 'Test error message')

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        flag: { key: 'test-flag' },
        evaluation_count: 1,
        runtime_default_used: true,
        error: { message: 'Test error message' },
        targeting_key: 'user123',
        timestamp: expect.any(Number),
      }),
    ])
  })

  it('should update last evaluation timestamp to differ from first evaluation timestamp on multiple evals', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }
    const mockDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    // Add first evaluation
    const firstEvalTime = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(firstEvalTime)
    aggregator.addEvaluation(mockContext, mockDetails)

    // Add second evaluation with different timestamp
    const secondEvalTime = firstEvalTime + 5000
    jest.spyOn(Date, 'now').mockReturnValue(secondEvalTime)
    aggregator.addEvaluation(mockContext, mockDetails)

    // Mock flush timestamp
    const flushTime = secondEvalTime + 1000
    jest.spyOn(Date, 'now').mockReturnValue(flushTime)

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        flag: { key: 'test-flag' },
        evaluation_count: 2,
        runtime_default_used: false,
        variant: { key: 'variant-a' },
        allocation: { key: 'allocation-123' },
        targeting_key: 'user123',
        first_evaluation: firstEvalTime,
        last_evaluation: secondEvalTime,
        timestamp: flushTime,
      }),
    ])

    // Verify timestamps are different
    const flushedEvent = onFlushSpy.mock.calls[0][0][0]
    expect(flushedEvent.first_evaluation).not.toEqual(flushedEvent.last_evaluation)
    expect(flushedEvent.last_evaluation).toBeGreaterThan(flushedEvent.first_evaluation)
  })

  it('should fire multiple events when targeting context changes but flag variant stays same', () => {
    const baseDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a', // Same variant
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    // First context
    const context1: EvaluationContext = { targetingKey: 'user123', country: 'US' }
    aggregator.addEvaluation(context1, baseDetails)

    // Second context with different targeting context but same variant
    const context2: EvaluationContext = { targetingKey: 'user123', country: 'CA' }
    aggregator.addEvaluation(context2, baseDetails)

    aggregator.start()
    jest.advanceTimersByTime(100)

    // Should have 2 separate events due to different targeting contexts
    expect(onFlushSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          flag: { key: 'test-flag' },
          variant: { key: 'variant-a' },
          targeting_key: 'user123',
          context: { evaluation: { country: 'US' } },
          evaluation_count: 1,
        }),
        expect.objectContaining({
          flag: { key: 'test-flag' },
          variant: { key: 'variant-a' },
          targeting_key: 'user123',
          context: { evaluation: { country: 'CA' } },
          evaluation_count: 1,
        }),
      ])
    )
    expect(onFlushSpy.mock.calls[0][0]).toHaveLength(2)
  })

  it('should populate runtime_default_used correctly for DEFAULT and ERROR reasons', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }

    // Test DEFAULT reason
    const defaultDetails: EvaluationDetails<boolean> = {
      flagKey: 'default-flag',
      value: false,
      reason: 'DEFAULT',
      flagMetadata: {},
    }
    aggregator.addEvaluation(mockContext, defaultDetails)

    // Test ERROR reason
    const errorDetails: EvaluationDetails<boolean> = {
      flagKey: 'error-flag',
      value: false,
      reason: 'ERROR',
      flagMetadata: {},
    }
    aggregator.addEvaluation(mockContext, errorDetails, 'Some error')

    // Test non-default reason
    const targetingDetails: EvaluationDetails<boolean> = {
      flagKey: 'targeting-flag',
      value: true,
      reason: 'TARGETING_MATCH',
      variant: 'variant-a',
      flagMetadata: {},
    }
    aggregator.addEvaluation(mockContext, targetingDetails)

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          flag: { key: 'default-flag' },
          runtime_default_used: true,
        }),
        expect.objectContaining({
          flag: { key: 'error-flag' },
          runtime_default_used: true,
        }),
        expect.objectContaining({
          flag: { key: 'targeting-flag' },
          runtime_default_used: false,
        }),
      ])
    )
  })

  it('should create separate aggregation entries for different flag/context combinations', () => {
    const baseDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    // Same flag, different contexts
    const context1: EvaluationContext = { targetingKey: 'user1', region: 'us-east' }
    const context2: EvaluationContext = { targetingKey: 'user1', region: 'us-west' }

    // Different flag, same context
    const context3: EvaluationContext = { targetingKey: 'user1', region: 'us-east' }
    const differentFlag: EvaluationDetails<boolean> = {
      ...baseDetails,
      flagKey: 'different-flag',
    }

    // Same flag and context, different variant
    const context4: EvaluationContext = { targetingKey: 'user1', region: 'us-east' }
    const differentVariant: EvaluationDetails<boolean> = {
      ...baseDetails,
      variant: 'variant-b',
    }

    aggregator.addEvaluation(context1, baseDetails)
    aggregator.addEvaluation(context2, baseDetails)
    aggregator.addEvaluation(context3, differentFlag)
    aggregator.addEvaluation(context4, differentVariant)

    aggregator.start()
    jest.advanceTimersByTime(100)

    // Should create 4 separate events
    expect(onFlushSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          flag: { key: 'test-flag' },
          variant: { key: 'variant-a' },
          context: { evaluation: { region: 'us-east' } },
          evaluation_count: 1,
        }),
        expect.objectContaining({
          flag: { key: 'test-flag' },
          variant: { key: 'variant-a' },
          context: { evaluation: { region: 'us-west' } },
          evaluation_count: 1,
        }),
        expect.objectContaining({
          flag: { key: 'different-flag' },
          variant: { key: 'variant-a' },
          context: { evaluation: { region: 'us-east' } },
          evaluation_count: 1,
        }),
        expect.objectContaining({
          flag: { key: 'test-flag' },
          variant: { key: 'variant-b' },
          context: { evaluation: { region: 'us-east' } },
          evaluation_count: 1,
        }),
      ])
    )
    expect(onFlushSpy.mock.calls[0][0]).toHaveLength(4)
  })

  it('should flush aggregated data when stopped before flush interval', () => {
    const mockContext: EvaluationContext = { targetingKey: 'user123' }
    const mockDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    // Add evaluations but don't start timer
    aggregator.addEvaluation(mockContext, mockDetails)
    aggregator.addEvaluation(mockContext, mockDetails)

    // Start aggregator
    aggregator.start()

    // Stop before flush interval (100ms) completes
    jest.advanceTimersByTime(50)
    aggregator.stop()

    // Should flush immediately on stop
    expect(onFlushSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        flag: { key: 'test-flag' },
        evaluation_count: 2,
        variant: { key: 'variant-a' },
        allocation: { key: 'allocation-123' },
        targeting_key: 'user123',
        runtime_default_used: false,
      }),
    ])
  })

  it('should handle empty targeting context correctly', () => {
    // Context with only targetingKey
    const contextWithTargetingKeyOnly: EvaluationContext = { targetingKey: 'user123' }

    // Context with empty object values
    const contextWithEmptyValues: EvaluationContext = { targetingKey: 'user456', data: {} }

    // Context with no targetingKey
    const contextWithoutTargetingKey: EvaluationContext = { customField: 'value' }

    const baseDetails: EvaluationDetails<boolean> = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    aggregator.addEvaluation(contextWithTargetingKeyOnly, baseDetails)
    aggregator.addEvaluation(contextWithEmptyValues, baseDetails)
    aggregator.addEvaluation(contextWithoutTargetingKey, baseDetails)

    aggregator.start()
    jest.advanceTimersByTime(100)

    expect(onFlushSpy).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          flag: { key: 'test-flag' },
          targeting_key: 'user123',
          evaluation_count: 1,
          // Should not have context property since no additional context data
        }),
        expect.objectContaining({
          flag: { key: 'test-flag' },
          targeting_key: 'user456',
          context: { evaluation: { data: {} } },
          evaluation_count: 1,
        }),
        expect.objectContaining({
          flag: { key: 'test-flag' },
          context: { evaluation: { customField: 'value' } },
          evaluation_count: 1,
          // Should not have targeting_key property
        }),
      ])
    )
    expect(onFlushSpy.mock.calls[0][0]).toHaveLength(3)
  })
})
