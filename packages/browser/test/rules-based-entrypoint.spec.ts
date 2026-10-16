import {
  composeDatadogTrackingHooks,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  DatadogProvider,
  enrichRumContext,
  fetchRulesConfiguration,
} from '../src/rules-based'

describe('rules-based entry point', () => {
  it('exports and registers rules-based browser APIs', () => {
    expect(DatadogProvider).toBeDefined()
    expect(DatadogCoreProvider).toBeDefined()
    expect(composeDatadogTrackingHooks).toBeDefined()
    expect(createDatadogExposureLoggingHook).toBeDefined()
    expect(createDatadogEvaluationLoggingHook).toBeDefined()
    expect(createDatadogRumTrackingHook).toBeDefined()
    expect(enrichRumContext).toBeDefined()
    expect(fetchRulesConfiguration).toBeDefined()
    expect((globalThis as { DD_FLAGGING?: { CoreProvider?: unknown } }).DD_FLAGGING?.CoreProvider).toBe(
      DatadogCoreProvider
    )
    expect((globalThis as { DD_FLAGGING?: { enrichRumContext?: unknown } }).DD_FLAGGING?.enrichRumContext).toBe(
      enrichRumContext
    )
  })
})
