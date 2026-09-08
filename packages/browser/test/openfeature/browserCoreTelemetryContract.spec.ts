import {
  FeatureFlagsTelemetryErrorCode,
  FeatureFlagsTelemetryEventType,
  startFeatureFlagsTelemetry,
} from '@datadog/browser-core'

describe('browser-core lifecycle telemetry contract', () => {
  it('is available from the installed browser-core package', () => {
    expect(typeof startFeatureFlagsTelemetry).toBe('function')
    expect(FeatureFlagsTelemetryEventType.PROVIDER_ERROR).toBe('provider_error')
    expect(FeatureFlagsTelemetryErrorCode.PRECOMPUTED_ASSIGNMENTS_FETCH_FAILED).toBe(
      'precomputed_assignments_fetch_failed'
    )
  })
})
