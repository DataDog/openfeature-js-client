import { createDatadogExposureLoggingHook, createDatadogTrackingHooks } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

const exposureLogging = createDatadogExposureLoggingHook(trackingOptions)
const tracking = createDatadogTrackingHooks(exposureLogging)

reportTrackingScenario('tracking-exposure', tracking)
