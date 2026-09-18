import {
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  createDatadogTrackingHooks,
  DatadogCoreProvider,
  DatadogProvider,
  fetchRulesConfiguration,
} from '../src/rules-based'

describe('rules-based entry point', () => {
  it('exports and registers rules-based browser APIs', () => {
    expect(DatadogProvider).toBeDefined()
    expect(DatadogCoreProvider).toBeDefined()
    expect(createDatadogTrackingHooks).toBeDefined()
    expect(createDatadogExposureLoggingHook).toBeDefined()
    expect(createDatadogEvaluationLoggingHook).toBeDefined()
    expect(createDatadogRumTrackingHook).toBeDefined()
    expect(fetchRulesConfiguration).toBeDefined()
    expect((globalThis as { DD_FLAGGING?: { CoreProvider?: unknown } }).DD_FLAGGING?.CoreProvider).toBe(
      DatadogCoreProvider
    )
  })
})
