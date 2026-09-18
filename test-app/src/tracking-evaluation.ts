import {
  createDatadogEvaluationLoggingHook,
  createDatadogTrackingHooks,
} from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

reportTrackingScenario(
  'tracking-evaluation',
  createDatadogTrackingHooks(createDatadogEvaluationLoggingHook(trackingOptions))
)
