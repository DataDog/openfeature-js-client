import {
  composeDatadogTrackingHooks,
  createDatadogEvaluationLoggingHook,
} from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

reportTrackingScenario(
  'tracking-evaluation',
  composeDatadogTrackingHooks(createDatadogEvaluationLoggingHook(trackingOptions))
)
