import { DatadogProvider } from '@datadog/openfeature-browser'
import { providerOptions, runProviderScenario } from './providerScenario'
import { reportError } from './smoke'

const provider = new DatadogProvider({
  ...providerOptions,
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
})

void runProviderScenario(provider).catch(reportError)
