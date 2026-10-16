import type { DatadogTrackingHooks, DatadogTrackingHooksOptions } from '@datadog/openfeature-browser/rules-based'
import { reportSuccess } from './smoke'

export const trackingOptions: DatadogTrackingHooksOptions = {
  clientToken: 'test-token',
  applicationId: 'test-application-id',
  site: 'datadoghq.com',
  service: 'packed-browser-smoke',
  env: 'test',
}

export function reportTrackingScenario(entrypoint: string, tracking: DatadogTrackingHooks): void {
  void tracking.initialize()
  reportSuccess({
    entrypoint,
    hooks: tracking.hooks.length,
  })
}
