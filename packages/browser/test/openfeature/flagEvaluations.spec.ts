import { createFlagEvaluationTrackingHook } from '../../src/openfeature/flagEvaluations'
import type { FlaggingConfiguration } from '../../src/domain/configuration'

const mockConfiguration: FlaggingConfiguration = {
  flagEvaluationEndpointBuilder: jest.fn(),
  flagEvaluationTrackingInterval: 1000,
  applicationId: 'test-app-id',
  fetchFlagsConfiguration: jest.fn(),
  service: 'test-service',
  batchBytesLimit: 64 * 1024,
  batchMessagesLimit: 500,
  messageBytesLimit: 256 * 1024,
  flushTimeout: 30000,
  exposuresEndpointBuilder: jest.fn(),
} as any

jest.mock('@datadog/browser-core', () => ({
  addTelemetryDebug: jest.fn(),
  createPageMayExitObservable: jest.fn(() => ({
    subscribe: jest.fn(),
  })),
  dateNow: jest.fn(() => 1234567890),
}))

jest.mock('../../src/transport/startFlagEvaluationBatch', () => ({
  startFlagEvaluationBatch: jest.fn(() => ({
    add: jest.fn(),
  })),
}))

describe('createFlagEvaluationTrackingHook', () => {
  it('should create a hook that tracks flag evaluations', () => {
    const hook = createFlagEvaluationTrackingHook(mockConfiguration)
    
    expect(hook).toBeDefined()
    expect(hook.after).toBeDefined()
  })

  it('should handle evaluation tracking in after hook', () => {
    const hook = createFlagEvaluationTrackingHook(mockConfiguration)
    
    const mockContext = {
      context: {
        targetingKey: 'user123',
      },
    }
    
    const mockDetails = {
      flagKey: 'test-flag',
      value: true,
      variant: 'variant-a',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation-123',
        targetingRuleKey: 'rule-456',
      },
    }

    expect(() => {
      hook.after?.(mockContext as any, mockDetails as any)
    }).not.toThrow()
  })
})