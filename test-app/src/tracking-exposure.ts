import { createDatadogExposureLoggingHook, createDatadogTrackingHooks } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

const exposureLogging = createDatadogExposureLoggingHook(trackingOptions)
const tracking = createDatadogTrackingHooks(exposureLogging)

void exposureLogging.resetExposureCache()
reportTrackingScenario('tracking-exposure', tracking)
