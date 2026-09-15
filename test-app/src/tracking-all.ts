import {
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  createDatadogTrackingHooks,
} from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

const exposureLogging = createDatadogExposureLoggingHook(trackingOptions)
const tracking = createDatadogTrackingHooks(
  exposureLogging,
  createDatadogEvaluationLoggingHook(trackingOptions),
  createDatadogRumTrackingHook()
)

void exposureLogging.resetExposureCache()
reportTrackingScenario('tracking-all', tracking)
