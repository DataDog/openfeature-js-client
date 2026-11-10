import { DatadogProvider, withRetry } from '@datadog/openfeature-browser'
import { type EvaluationContext, OpenFeature, ProviderEvents } from '@openfeature/web-sdk'

const events: string[] = []
for (const event of [ProviderEvents.Ready, ProviderEvents.Stale, ProviderEvents.Error]) {
  OpenFeature.addHandler(event, () => events.push(event))
}
let provider: DatadogProvider
const client = OpenFeature.getClient()
async function settle(action: () => Promise<void>) {
  let error: string | undefined
  try {
    await action()
  } catch (caught) {
    error = String(caught)
  }
  // STALE is emitted after OpenFeature's context reconciliation completes.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { status: provider.status, error, events: [...events] }
}
Object.assign(window, {
  authorizationTest: {
    initialize: (origin: string, context: EvaluationContext) => {
      provider = new DatadogProvider({
        clientToken: 'local-validation-client',
        applicationId: 'local-validation-app',
        env: 'test',
        flaggingProxy: `${origin}/assignments`,
        flagConfigurationFetch: withRetry(fetch, 2),
        enableRumFeatureFlagTracking: false,
        flagEvaluationTrackingInterval: 1000,
        proxy: ({ path, parameters }) => `${origin}/intake${path}?${parameters}`,
      })
      return settle(() => OpenFeature.setProviderAndWait(provider, context))
    },
    update: (context: EvaluationContext) => settle(() => OpenFeature.setContext(context)),
    evaluate: () => ({
      boolean: client.getBooleanDetails('boolean-flag', false),
      string: client.getStringValue('string-flag', 'fallback'),
      integer: client.getNumberValue('integer-flag', -1),
      number: client.getNumberValue('numeric-flag', -1),
      object: client.getObjectValue('json-flag', {}),
      missing: client.getBooleanDetails('absent', false),
    }),
    close: () => OpenFeature.clearProviders(),
  },
})
