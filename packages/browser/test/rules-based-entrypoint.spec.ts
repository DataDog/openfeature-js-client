import { getClientFingerprint as getSharedClientFingerprint } from '../src/client-fingerprint'
import {
  type ClientFingerprint,
  composeDatadogTrackingHooks,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  DatadogProvider,
  fetchRulesConfiguration,
  getClientFingerprint,
} from '../src/rules-based'

describe('rules-based entry point', () => {
  it('exports the shared fingerprint getter and type', () => {
    const fingerprint: ClientFingerprint = getClientFingerprint()
    expect(getClientFingerprint).toBe(getSharedClientFingerprint)
    expect(fingerprint).toBe(getSharedClientFingerprint())
  })

  it('exports and registers rules-based browser APIs', () => {
    expect(DatadogProvider).toBeDefined()
    expect(DatadogCoreProvider).toBeDefined()
    expect(composeDatadogTrackingHooks).toBeDefined()
    expect(createDatadogExposureLoggingHook).toBeDefined()
    expect(createDatadogEvaluationLoggingHook).toBeDefined()
    expect(createDatadogRumTrackingHook).toBeDefined()
    expect(fetchRulesConfiguration).toBeDefined()
    expect((globalThis as { DD_FLAGGING?: { CoreProvider?: unknown } }).DD_FLAGGING?.CoreProvider).toBe(
      DatadogCoreProvider
    )
  })
})
