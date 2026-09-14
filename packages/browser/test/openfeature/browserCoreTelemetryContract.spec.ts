import {
  FeatureFlagsTelemetryConfigurationSource,
  FeatureFlagsTelemetryErrorCode,
  FeatureFlagsTelemetryEventType,
  FeatureFlagsTelemetryProviderStatus,
  startFeatureFlagsTelemetry,
} from '@datadog/browser-core'

describe('browser-core flagtelemetry contract', () => {
  it('is available from the installed browser-core package', () => {
    expect(typeof startFeatureFlagsTelemetry).toBe('function')
    expect(Object.values(FeatureFlagsTelemetryEventType)).toEqual([
      'sdk_init_started',
      'configuration_received',
      'provider_ready',
      'provider_error',
      'first_evaluation',
      'init_timeout',
      'init_failed',
    ])
    expect(Object.values(FeatureFlagsTelemetryErrorCode)).toEqual([
      'precomputed_assignments_fetch_failed',
      'initialization_timeout',
      'initialization_failed',
    ])
    expect(Object.values(FeatureFlagsTelemetryConfigurationSource)).toEqual(['remote', 'cache'])
    expect(Object.values(FeatureFlagsTelemetryProviderStatus)).toEqual(['ready', 'stale', 'error'])
  })
})
