import { evaluatePrecomputedConfiguration } from '@datadog/flagging-core'
import { configurationFromString, configurationToString, DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'
import { reportError, reportSuccess } from './smoke'

async function run() {
  const context = { targetingKey: 'numeric-subject' }
  const response = await fetch('/assignments').then((response) => response.text())
  const configuration = configurationFromString(JSON.stringify({ version: 1, precomputed: { context, response } }))
  const restored = configurationFromString(configurationToString(configuration))
  const core = evaluatePrecomputedConfiguration(restored, 'number', 'probe', -99.5, context)
  const provider = new DatadogProvider({
    clientToken: 'local-numeric-test',
    env: 'test',
    flaggingProxy: new URL('/assignments', location.href).toString(),
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
  })
  try {
    await OpenFeature.setProviderAndWait(provider, context)
    const browser = OpenFeature.getClient().getNumberDetails('probe', -99.5)
    reportSuccess({ core, browser })
  } finally {
    await OpenFeature.clearProviders()
  }
}
run().catch(reportError)
