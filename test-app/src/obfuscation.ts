import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'
import { reportSuccess } from './smoke'

async function run() {
  const parameters = new URLSearchParams(location.search)
  const exposures = parameters.has('exposures')
  const provider = new DatadogProvider({
    clientToken: parameters.get('token') || 'obfuscation-smoke-token',
    env: 'test',
    flaggingProxy: new URL('/assignments', location.href).toString(),
    customHeaders: { 'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1' },
    enableExposureLogging: exposures,
    ...(exposures ? { proxy: new URL('/exposures', location.href).toString() } : {}),
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
    ...(parameters.has('offline')
      ? {
          flagConfigurationFetch: async () => {
            throw new Error('Offline test')
          },
        }
      : {}),
  })
  await OpenFeature.setProviderAndWait(provider, { targetingKey: 'browser-smoke-subject' })
  const client = OpenFeature.getClient()
  const details = client.getBooleanDetails('new-route-planner', false)
  const result = {
    values: [
      details.value,
      client.getStringValue('café', 'default'),
      client.getNumberValue('number-flag', -1),
      client.getObjectValue('object-flag', {}),
    ],
    flagKey: details.flagKey,
    variant: details.variant,
    reason: details.reason,
    missing: client.getBooleanDetails('missing-flag', false).errorCode,
    mismatch: client.getStringDetails('new-route-planner', 'default').errorCode,
    status: provider.status,
  }
  if (exposures) await OpenFeature.clearProviders()
  reportSuccess(result)
}

run().catch((error: unknown) => {
  Object.assign(globalThis, { __OPENFEATURE_SMOKE_ERROR__: String(error) })
})
