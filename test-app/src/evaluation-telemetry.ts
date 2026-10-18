import { DatadogProvider } from '@datadog/openfeature-browser'
import {
  composeDatadogTrackingHooks,
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  type DatadogTrackingHooks,
  fetchPrecomputedConfiguration,
} from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'
import rulesWire from '../../packages/browser/test/data/rules-v1-wire.json'
import { reportError, reportSuccess } from './smoke'

async function run() {
  const parameters = new URLSearchParams(location.search)
  const mode = parameters.get('mode') || 'online'
  const activated = parameters.get('activated') === 'true'
  const optedOut = parameters.get('optedOut') === 'true'
  const subject = { targetingKey: 'browser-subject', country: 'US' }
  const context = { ...subject, dd_evaluation_telemetry_opt_out: optedOut }
  const options = {
    clientToken: 'local-telemetry-test',
    env: 'test',
    flagEvaluationTrackingInterval: 1000,
    proxy: ({ path, parameters }: { path: string; parameters: string }) =>
      new URL(`/intake${path}?${parameters}`, location.href).toString(),
  }
  const rum: string[] = []
  Object.assign(globalThis, { DD_RUM: { addFeatureFlagEvaluation: (key: string) => rum.push(key) } })
  let tracking: DatadogTrackingHooks | undefined
  let coreProvider: DatadogCoreProvider | undefined
  const fetchAssignments = (context: typeof subject & { dd_evaluation_telemetry_opt_out: boolean }) =>
    fetchPrecomputedConfiguration({
      ...options,
      context,
      fetch: (_url, init) => fetch(new URL('/assignments', location.href), init),
    })
  const client = OpenFeature.getClient()
  if (mode === 'online') {
    await OpenFeature.setProviderAndWait(
      new DatadogProvider({
        ...options,
        enableEvaluationTelemetryOptOutParameter: activated,
        flaggingProxy: new URL('/assignments', location.href).toString(),
      }),
      context
    )
  } else {
    const provider = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: activated })
    coreProvider = provider
    const configuration =
      mode === 'rules' ? configurationFromString(JSON.stringify(rulesWire)) : await fetchAssignments(context)
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait(provider, context)
    tracking = composeDatadogTrackingHooks(
      createDatadogEvaluationLoggingHook(options),
      createDatadogExposureLoggingHook(options),
      createDatadogRumTrackingHook()
    )
    await tracking.initialize()
    client.addHooks(...tracking.hooks)
  }
  let customerHooks = 0
  client.addHooks({
    finally: () => {
      customerHooks++
    },
  })
  const flag = mode === 'rules' ? 'test-flag' : 'browser-flag'
  Object.assign(globalThis, {
    telemetryTest: {
      evaluate: () => ({
        value: client.getBooleanValue(flag, false),
        repeated: client.getBooleanValue(flag, false),
        missing: client.getBooleanDetails('missing', false).errorCode,
        mismatch: client.getStringDetails(flag, 'fallback').errorCode,
      }),
      update: async (optOut: boolean) => {
        const nextContext = { ...subject, dd_evaluation_telemetry_opt_out: optOut }
        if (mode === 'precomputed') coreProvider!.setConfiguration(await fetchAssignments(nextContext))
        await OpenFeature.setContext(nextContext)
      },
      close: async () => {
        await tracking?.shutdown()
        await OpenFeature.clearProviders()
        return { rum, customerHooks }
      },
    },
  })
  reportSuccess({ ready: true })
}

run().catch(reportError)
