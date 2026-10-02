import { FlagEvaluationAggregator } from '@datadog/flagging-core'
import { ErrorCode, type EvaluationDetails, type HookContext } from '@openfeature/web-sdk'
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
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('should create a hook that tracks flag evaluations', () => {
    const hook = createFlagEvalEVPHook(mockConfiguration)

    expect(hook).toBeDefined()
    expect(hook.after).toBeUndefined()
    expect(hook.finally).toBeDefined()
  })

  it.each([
    { errorCode: undefined, errorMessage: undefined, expectedError: undefined },
    { errorCode: ErrorCode.FLAG_NOT_FOUND, errorMessage: 'Flag not found', expectedError: 'FLAG_NOT_FOUND' },
    { errorCode: ErrorCode.GENERAL, errorMessage: 'Invalid user private@example.com', expectedError: 'GENERAL' },
    { errorCode: ErrorCode.TYPE_MISMATCH, errorMessage: '', expectedError: 'TYPE_MISMATCH' },
    { errorCode: ErrorCode.PROVIDER_NOT_READY, errorMessage: undefined, expectedError: 'PROVIDER_NOT_READY' },
  ])('tracks evaluation details in finally: $expectedError', ({ errorCode, errorMessage, expectedError }) => {
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
      variant: errorCode ? undefined : 'variant-a',
      reason: errorCode ? 'ERROR' : 'TARGETING_MATCH',
      errorCode,
      errorMessage,
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
      hook.finally?.(mockContext, mockDetails)
    }).not.toThrow()
    expect(addEvaluationSpy).toHaveBeenCalledTimes(1)
    expect(addEvaluationSpy).toHaveBeenCalledWith(effectiveContext, mockDetails, expectedError)
  })
})
