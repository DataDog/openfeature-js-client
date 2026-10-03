import { FlagEvaluationAggregator } from '@datadog/flagging-core'
import { ErrorCode, type EvaluationDetails, type HookContext } from '@openfeature/web-sdk'
import { validateAndBuildFlaggingTrackingConfiguration } from '../../src/domain/configuration'
import { createFlagEvalEVPHook } from '../../src/openfeature/flagEvaluations'

const mockConfiguration = validateAndBuildFlaggingTrackingConfiguration({
  clientToken: 'tracking-token',
  flagEvaluationTrackingInterval: 1000,
  applicationId: 'test-app-id',
  service: 'test-service',
})!

jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  addTelemetryDebug: jest.fn(),
  createBatch: jest.fn(() => ({
    add: jest.fn(),
    stop: jest.fn(),
  })),
  createFlushController: jest.fn(),
  createHttpRequest: jest.fn(),
  createIdentityEncoder: jest.fn(),
  createPageMayExitObservable: jest.fn(() => ({
    subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
  })),
  Observable: jest.fn().mockImplementation(() => ({ notify: jest.fn() })),
}))

describe('createFlagEvalEVPHook', () => {
  let hook: ReturnType<typeof createFlagEvalEVPHook> | undefined

  beforeEach(() => {
    jest.useFakeTimers()
    hook = undefined
  })

  afterEach(() => {
    try {
      hook?.shutdown()
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.restoreAllMocks()
      jest.useRealTimers()
    }
  })

  it('should create a hook that tracks flag evaluations', () => {
    hook = createFlagEvalEVPHook(mockConfiguration)

    expect(hook).toBeDefined()
    expect(hook.after).toBeUndefined()
    expect(hook.finally).toBeDefined()
  })

  it.each([
    { errorCode: undefined, errorMessage: undefined, expectedError: undefined },
    ...Object.values(ErrorCode).map((errorCode) => ({
      errorCode,
      errorMessage: 'Invalid user private@example.com',
      expectedError: errorCode,
    })),
    { errorCode: ErrorCode.TYPE_MISMATCH, errorMessage: '', expectedError: ErrorCode.TYPE_MISMATCH },
    { errorCode: ErrorCode.PROVIDER_NOT_READY, errorMessage: undefined, expectedError: ErrorCode.PROVIDER_NOT_READY },
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
    hook = createFlagEvalEVPHook(mockConfiguration, () => effectiveContext)

    expect(() => {
      hook?.finally?.(mockContext, mockDetails)
    }).not.toThrow()
    expect(addEvaluationSpy).toHaveBeenCalledTimes(1)
    expect(addEvaluationSpy).toHaveBeenCalledWith(effectiveContext, mockDetails, expectedError)
  })
})
