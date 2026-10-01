import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'
import { reportSuccess } from './smoke'

async function run() {
  const provider = new DatadogProvider({
    clientToken: 'obfuscation-smoke-token',
    env: 'test',
    flaggingProxy: new URL('/assignments', location.href).toString(),
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
    ...(new URLSearchParams(location.search).has('offline')
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
  reportSuccess({
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
  })
}

run().catch((error: unknown) => {
  Object.assign(globalThis, { __OPENFEATURE_SMOKE_ERROR__: String(error) })
})
