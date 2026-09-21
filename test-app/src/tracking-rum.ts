import { composeDatadogTrackingHooks, createDatadogRumTrackingHook } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario } from './trackingScenario'

reportTrackingScenario('tracking-rum', composeDatadogTrackingHooks(createDatadogRumTrackingHook()))
