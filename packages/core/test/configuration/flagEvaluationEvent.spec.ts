import { createFlagEvaluationEvent } from '../../src/configuration/flagEvaluationEvent'
import type { TimeStamp } from '../../src/time'

describe('createFlagEvaluationEvent', () => {
  it('should include targeting_key when it is a non-empty string', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: 'user123',
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      2000 as TimeStamp
    )

    expect(event.targeting_key).toBe('user123')
  })

  it('should include targeting_key when it is an empty string', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: '',
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      2000 as TimeStamp
    )

    expect(event.targeting_key).toBe('')
    expect(event).toHaveProperty('targeting_key')
  })

  it('should not include targeting_key when it is undefined', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: undefined,
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      2000 as TimeStamp
    )

    expect(event).not.toHaveProperty('targeting_key')
  })

  it('should include all required fields', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        variantKey: 'variant-a',
        allocationKey: 'allocation-123',
        targetingRuleKey: 'rule-456',
        targetingKey: 'user123',
        count: 5,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 5000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      6000 as TimeStamp
    )

    expect(event).toEqual({
      flag: { key: 'test-flag' },
      first_evaluation: 1000,
      last_evaluation: 5000,
      evaluation_count: 5,
      runtime_default_used: false,
      timestamp: 6000,
      targeting_key: 'user123',
      variant: { key: 'variant-a' },
      allocation: { key: 'allocation-123' },
      targeting_rule: { key: 'rule-456' },
    })
  })

  it('should include error when present', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: 'user123',
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: true,
        error: 'Test error message',
      },
      2000 as TimeStamp
    )

    expect(event.error).toEqual({ message: 'Test error message' })
  })

  it('should include targeting context when present', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: 'user123',
        targetingContext: {
          country: 'US',
          browser: 'Chrome',
        },
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      2000 as TimeStamp
    )

    expect(event.context).toEqual({
      evaluation: {
        country: 'US',
        browser: 'Chrome',
      },
    })
  })

  it('should not include context when targeting context is empty', () => {
    const event = createFlagEvaluationEvent(
      {
        flagKey: 'test-flag',
        targetingKey: 'user123',
        targetingContext: {},
        count: 1,
        firstEvaluation: 1000 as TimeStamp,
        lastEvaluation: 1000 as TimeStamp,
        runtimeDefaultUsed: false,
      },
      2000 as TimeStamp
    )

    expect(event).not.toHaveProperty('context')
  })
})
