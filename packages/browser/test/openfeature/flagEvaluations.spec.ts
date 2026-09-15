import { createBatch } from '@datadog/browser-core'
import { FlagEvaluationAggregator } from '@datadog/flagging-core'
import type { EvaluationDetails, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../../src/domain/configuration'
import { createFlagEvalEVPHook } from '../../src/openfeature/flagEvaluations'

const mockConfiguration: FlaggingConfiguration = {
  flagEvaluationTrackingInterval: 1000,
  applicationId: 'test-app-id',
  fetchFlagsConfiguration: jest.fn(),
  service: 'test-service',
  exposuresEndpointBuilder: jest.fn() as any,
  flagEvaluationEndpointBuilder: jest.fn() as any,
  // Add required Configuration properties
  site: 'datadoghq.com',
  version: '1.0.0',
  sessionSampleRate: 100,
  telemetrySampleRate: 20,
  // `as unknown as FlaggingConfiguration` is intentional: FlaggingConfiguration inherits many required
  // fields from Configuration/TransportConfiguration (beforeSend, logsEndpointBuilder, sdkVersion, etc.)
  // that createFlagEvalEVPHook never reads. All @datadog/browser-core imports used by
  // createFlagEvalEVPHook are mocked at the module level below, so missing fields don't
  // cause runtime failures.
} as unknown as FlaggingConfiguration

jest.mock('@datadog/browser-core', () => ({
  addTelemetryDebug: jest.fn(),
  createBatch: jest.fn(() => ({
    add: jest.fn(),
    forceFlush: jest.fn(),
    stop: jest.fn(),
    prepareUrgentFlushObservable: {
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    },
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

describe('createFlagEvalEVPHook', () => {
  it('should create a hook that tracks flag evaluations', () => {
    const hook = createFlagEvalEVPHook(mockConfiguration)

    expect(hook).toBeDefined()
    expect(hook.after).toBeDefined()
  })

  it('should handle evaluation tracking in after hook', () => {
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
      hookData: {
        set: jest.fn(),
        get: jest.fn(),
        has: jest.fn(),
        delete: jest.fn(),
        clear: jest.fn(),
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

    const effectiveContext = {
      targetingKey: 'rum-user',
      user_email: 'rum@example.com',
    }
    const addEvaluationSpy = jest.spyOn(FlagEvaluationAggregator.prototype, 'addEvaluation')
    const hook = createFlagEvalEVPHook(mockConfiguration, () => effectiveContext)

    expect(() => {
      hook.after?.(mockContext, mockDetails)
    }).not.toThrow()
    expect(addEvaluationSpy).toHaveBeenCalledWith(effectiveContext, mockDetails)
    addEvaluationSpy.mockRestore()
  })

  it('flushes and stops once and ignores evaluations after it is stopped', () => {
    const stopAggregatorSpy = jest.spyOn(FlagEvaluationAggregator.prototype, 'stop')
    const addEvaluationSpy = jest.spyOn(FlagEvaluationAggregator.prototype, 'addEvaluation')
    const hook = createFlagEvalEVPHook(mockConfiguration)
    const batch = jest.mocked(createBatch).mock.results.at(-1)?.value
    expect(batch).toBeDefined()
    if (!batch) {
      throw new Error('Expected createBatch to return a batch')
    }

    hook.stop()
    hook.stop()
    hook.after?.({} as HookContext, {} as EvaluationDetails<boolean>)

    expect(stopAggregatorSpy).toHaveBeenCalledTimes(1)
    expect(batch.forceFlush).toHaveBeenCalledWith('duration_limit')
    expect(batch.stop).toHaveBeenCalledTimes(1)
    expect(addEvaluationSpy).not.toHaveBeenCalled()
    stopAggregatorSpy.mockRestore()
    addEvaluationSpy.mockRestore()
  })

  it('continues cleanup when flushing throws', () => {
    const hook = createFlagEvalEVPHook(mockConfiguration)
    const batch = jest.mocked(createBatch).mock.results.at(-1)?.value
    expect(batch).toBeDefined()
    if (!batch) {
      throw new Error('Expected createBatch to return a batch')
    }
    batch.forceFlush.mockImplementationOnce(() => {
      throw new Error('flush failed')
    })

    expect(() => hook.stop()).not.toThrow()
    expect(batch.stop).toHaveBeenCalledTimes(1)
  })
})
