import {
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  createDatadogTrackingHooks,
  DatadogOfflineProvider,
  DatadogProvider,
  fetchRulesConfiguration,
} from '../src/rules-based'

describe('rules-based entry point', () => {
  it('exports and registers rules-based browser APIs', () => {
    expect(DatadogProvider).toBeDefined()
    expect(DatadogOfflineProvider).toBeDefined()
    expect(createDatadogTrackingHooks).toBeDefined()
    expect(createDatadogExposureLoggingHook).toBeDefined()
    expect(createDatadogEvaluationLoggingHook).toBeDefined()
    expect(createDatadogRumTrackingHook).toBeDefined()
    expect(fetchRulesConfiguration).toBeDefined()
    expect((globalThis as { DD_FLAGGING?: { OfflineProvider?: unknown } }).DD_FLAGGING?.OfflineProvider).toBe(
      DatadogOfflineProvider
    )
  })
})
