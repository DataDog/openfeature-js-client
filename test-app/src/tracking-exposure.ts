import { composeDatadogTrackingHooks, createDatadogExposureLoggingHook } from '@datadog/openfeature-browser/rules-based'
import { reportTrackingScenario, trackingOptions } from './trackingScenario'

const exposureLogging = createDatadogExposureLoggingHook(trackingOptions)
const tracking = composeDatadogTrackingHooks(exposureLogging)

reportTrackingScenario('tracking-exposure', tracking)
