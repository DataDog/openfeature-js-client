import type { EvaluationDetails, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../../src/domain/configuration'
import { createFlagEvaluationTrackingHook } from '../../src/openfeature/flagEvaluations'

const mockConfiguration: FlaggingConfiguration = {
  flagEvaluationTrackingInterval: 1000,
  applicationId: 'test-app-id',
  fetchFlagsConfiguration: jest.fn(),
  service: 'test-service',
  batchBytesLimit: 64 * 1024,
  batchMessagesLimit: 500,
  messageBytesLimit: 256 * 1024,
  flushTimeout: 30000 as any,
  exposuresEndpointBuilder: jest.fn() as any,
  flagEvaluationEndpointBuilder: jest.fn() as any,
  // Add required Configuration properties
  site: 'datadoghq.com',
  version: '1.0.0',
  sessionSampleRate: 100,
  telemetrySampleRate: 20,
  replica: {} as any,
  sendToExtensionPredicate: () => false,
} as unknown as FlaggingConfiguration

jest.mock('@datadog/browser-core', () => ({
  addTelemetryDebug: jest.fn(),
  createBatch: jest.fn(() => ({
    add: jest.fn(),
  })),
  createFlushController: jest.fn(),
  createHttpRequest: jest.fn(),
  createIdentityEncoder: jest.fn(),
  createPageMayExitObservable: jest.fn(() => ({
    subscribe: jest.fn(),
  })),
  Observable: jest.fn().mockImplementation(() => ({})),
  dateNow: jest.fn(() => 1234567890),
}))


describe('createFlagEvaluationTrackingHook', () => {
  it('should create a hook that tracks flag evaluations', () => {
    const hook = createFlagEvaluationTrackingHook(mockConfiguration)

    expect(hook).toBeDefined()
    expect(hook.after).toBeDefined()
  })

  it('should handle evaluation tracking in after hook', () => {
    const hook = createFlagEvaluationTrackingHook(mockConfiguration)

    const mockContext: HookContext = {
      flagKey: 'test-flag',
      defaultValue: true,
      flagValueType: 'boolean' as any,
      context: {
        targetingKey: 'user123',
      },
      clientMetadata: {
        name: 'test-client',
        providerMetadata: {
          name: 'test-provider',
        },
      },
      providerMetadata: {
        name: 'test-provider',
      },
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as any,
    }

    const mockDetails: EvaluationDetails<boolean> = {
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
      hook.after?.(mockContext, mockDetails)
    }).not.toThrow()
  })
})
