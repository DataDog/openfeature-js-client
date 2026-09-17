import { getGlobalObject } from '@datadog/browser-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, HookContext } from '@openfeature/web-sdk'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import { createRumTrackingHook, enrichRumContext } from '../../src/openfeature/rumIntegration'

describe('createRumTrackingHook', () => {
  const mockHookContext = {} as HookContext

  const makeDetails = (flagKey: string, variantKey: string, variantValue: FlagValue): EvaluationDetails<FlagValue> =>
    ({ flagKey, variant: variantKey, value: variantValue }) as EvaluationDetails<FlagValue>

  afterEach(() => {
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    delete globalObject.DD_RUM
  })

  it('should call DD_RUM.addFeatureFlagEvaluation with the variant key when DD_RUM is present', () => {
    const mockAddFeatureFlagEvaluation = jest.fn()
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    globalObject.DD_RUM = { addFeatureFlagEvaluation: mockAddFeatureFlagEvaluation }

    const hook = createRumTrackingHook()
    hook.after!(mockHookContext, makeDetails('test-flag', 'variant-a', true))

    expect(mockAddFeatureFlagEvaluation).toHaveBeenCalledWith('test-flag', 'variant-a')
  })

  it('should be a no-op when DD_RUM is absent', () => {
    const hook = createRumTrackingHook()
    expect(() => hook.after!(mockHookContext, makeDetails('test-flag', 'variant-a', 'foo-bar-baz'))).not.toThrow()
  })

  it('should detect DD_RUM that loads after hook creation (lazy detection)', () => {
    const hook = createRumTrackingHook()

    // First call: DD_RUM not yet loaded
    hook.after!(mockHookContext, makeDetails('flag-1', 'variant-key-a', 'foo-bar-baz'))

    // Now DD_RUM loads
    const mockAddFeatureFlagEvaluation = jest.fn()
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    globalObject.DD_RUM = { addFeatureFlagEvaluation: mockAddFeatureFlagEvaluation }

    // Second call: should pick up DD_RUM
    hook.after!(mockHookContext, makeDetails('flag-2', 'variant-key-b', 'qux-quux-quuz'))

    expect(mockAddFeatureFlagEvaluation).toHaveBeenCalledTimes(1)
    expect(mockAddFeatureFlagEvaluation).toHaveBeenCalledWith('flag-2', 'variant-key-b')
  })

  it('should not call addFeatureFlagEvaluation when variant is null', () => {
    const mockAddFeatureFlagEvaluation = jest.fn()
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    globalObject.DD_RUM = { addFeatureFlagEvaluation: mockAddFeatureFlagEvaluation }

    const hook = createRumTrackingHook()
    hook.after!(mockHookContext, {
      flagKey: 'test-flag',
      variant: undefined,
      value: 'default',
    } as EvaluationDetails<FlagValue>)

    expect(mockAddFeatureFlagEvaluation).not.toHaveBeenCalled()
  })

  it('should be a no-op when DD_RUM exists but lacks addFeatureFlagEvaluation', () => {
    const globalObject = getGlobalObject<{ DD_RUM?: Partial<DDRum> }>()
    globalObject.DD_RUM = {} as DDRum

    const hook = createRumTrackingHook()
    expect(() => hook.after!(mockHookContext, makeDetails('test-flag', 'variant-key-a', 'foo-bar-baz'))).not.toThrow()
  })

  it('should pass the variant key, not the value', () => {
    const mockAddFeatureFlagEvaluation = jest.fn()
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    globalObject.DD_RUM = { addFeatureFlagEvaluation: mockAddFeatureFlagEvaluation }

    const hook = createRumTrackingHook()

    const details = makeDetails('my-flag', 'variant-key-a', true)
    hook.after!(mockHookContext, details)

    expect(mockAddFeatureFlagEvaluation).toHaveBeenCalledWith('my-flag', 'variant-key-a')
  })

  describe('enrichRumContext', () => {
    it('should add flat primitive user properties while preserving application context precedence', () => {
      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM = {
        addFeatureFlagEvaluation: jest.fn(),
        getUser: () => ({
          id: 'rum-user',
          targetingKey: 'rum-custom-targeting-key',
          user_email: 'rum@example.com',
          company_name: 'Example, Inc.',
          age: 42,
          active: true,
          empty: null,
          profile: { plan: 'enterprise' },
          roles: ['admin'],
        }),
      }

      expect(
        enrichRumContext({
          targetingKey: 'explicit-user',
          user_email: 'explicit@example.com',
          request_attribute: 'request-value',
          request_metadata: { source: 'application' },
        })
      ).toEqual({
        targetingKey: 'explicit-user',
        user_email: 'explicit@example.com',
        company_name: 'Example, Inc.',
        age: 42,
        active: true,
        request_attribute: 'request-value',
        request_metadata: { source: 'application' },
      })
    })

    it('should use the RUM user ID instead of a RUM targetingKey property', () => {
      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM = {
        addFeatureFlagEvaluation: jest.fn(),
        getUser: () => ({ id: 'rum-user', targetingKey: 'rum-custom-targeting-key' }),
      }

      expect(enrichRumContext({})).toEqual({ targetingKey: 'rum-user' })
    })

    it('should remove RUM defaults explicitly set to undefined by the application', () => {
      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM = {
        addFeatureFlagEvaluation: jest.fn(),
        getUser: () => ({ id: 'rum-user', user_email: 'rum@example.com' }),
      }

      const context = {
        targetingKey: undefined,
        user_email: undefined,
        region: 'us-east-1',
      } as unknown as EvaluationContext
      expect(enrichRumContext(context)).toEqual({ region: 'us-east-1' })
    })

    it('should normalize application context when RUM user lookup is unavailable', () => {
      const context = { targetingKey: 'explicit-user', user_email: undefined } as unknown as EvaluationContext
      expect(enrichRumContext(context)).toEqual({ targetingKey: 'explicit-user' })

      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM = {
        addFeatureFlagEvaluation: jest.fn(),
        getUser: () => {
          throw new Error('RUM is not initialized')
        },
      }
      expect(enrichRumContext(context)).toEqual({ targetingKey: 'explicit-user' })
    })
  })
})
