import { createDatadogTrackingHooks } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario } from './trackingScenario'

reportTrackingScenario('tracking-baseline', createDatadogTrackingHooks())
