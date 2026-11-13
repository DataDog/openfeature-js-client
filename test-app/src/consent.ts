import {
  configurationFromString,
  configurationToString,
  evaluatePrecomputedConfiguration,
} from '@datadog/flagging-core'
import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'
import { reportError, reportSuccess } from './smoke'

async function run() {
  const context = { targetingKey: 'user123', user_id: '123', country: 'US' }
  const response = await fetch('/assignments').then((response) => response.json())
  const configuration = configurationFromString(
    JSON.stringify({
      version: response.data.attributes.obfuscated ? 2 : 1,
      precomputed: { context, response: JSON.stringify(response) },
    })
  )
  const restored = configurationFromString(configurationToString(configuration))
  const core = evaluatePrecomputedConfiguration(restored, 'string', 'country-message', 'default', context)
  const provider = new DatadogProvider({
    clientToken: 'local-consent-test',
    env: 'test',
    flaggingProxy: new URL('/assignments', location.href).toString(),
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
  })
  await OpenFeature.setProviderAndWait(provider, context)
  const client = OpenFeature.getClient()
  const browser = client.getStringDetails('country-message', 'default')
  const missing = client.getStringDetails('missing', 'fallback')
  const mismatch = client.getBooleanDetails('country-message', false)
  await OpenFeature.clearProviders()
  reportSuccess({ core, browser, missing, mismatch })
}
run().catch(reportError)
