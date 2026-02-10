import { getGlobalObject } from '@datadog/browser-core'
import type { EvaluationDetails, FlagValue, HookContext } from '@openfeature/web-sdk'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import { createRumTrackingHook } from '../../src/openfeature/rumIntegration'

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
})
