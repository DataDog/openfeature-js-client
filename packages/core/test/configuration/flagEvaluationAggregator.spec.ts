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
    const mockContext = { targetingKey: 'user123' }
    const mockDetails = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
      },
    }

    aggregator.addEvaluation(mockContext, mockDetails as any)
    aggregator.addEvaluation(mockContext, mockDetails as any)

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
    const mockContext = { targetingKey: 'user123' }
    const mockDetails = {
      flagKey: 'test-flag',
      value: false,
      reason: 'DEFAULT',
    }

    aggregator.addEvaluation(mockContext, mockDetails as any)

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
    const mockContext = { targetingKey: 'user123' }
    const mockDetails = {
      flagKey: 'test-flag',
      value: false,
      reason: 'ERROR',
    }

    aggregator.addEvaluation(mockContext, mockDetails as any, 'Test error message')

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
})