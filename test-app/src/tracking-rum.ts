import { createDatadogRumTrackingHook, createDatadogTrackingHooks } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario } from './trackingScenario'

reportTrackingScenario('tracking-rum', createDatadogTrackingHooks(createDatadogRumTrackingHook()))
