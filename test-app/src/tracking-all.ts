import {
  composeDatadogTrackingHooks,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
} from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

const exposureLogging = createDatadogExposureLoggingHook(trackingOptions)
const tracking = composeDatadogTrackingHooks(
  exposureLogging,
  createDatadogEvaluationLoggingHook(trackingOptions),
  createDatadogRumTrackingHook()
)

reportTrackingScenario('tracking-all', tracking)
