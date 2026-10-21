import { DatadogProvider, ExperimentationOptOutMode } from '@datadog/openfeature-browser'
import {
  composeDatadogTrackingHooks,
  configurationFromString,
  configurationToString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
  type DatadogTrackingHooks,
  fetchPrecomputedConfiguration,
} from '@datadog/openfeature-browser/rules-based'
import { type EvaluationContext, OpenFeature } from '@openfeature/web-sdk'
import rulesWire from '../../packages/browser/test/data/rules-v1-wire.json'
import { reportError, reportSuccess } from './smoke'

async function run() {
  const parameters = new URLSearchParams(location.search)
  const mode = parameters.get('mode') || 'online'
  const active = parameters.get('disabled') !== 'true'
  const optedOut = parameters.get('optedOut') === 'true'
  const options = {
    clientToken: 'local-experimentation-opt-out',
    env: 'test',
    experimentationOptOutMode: active
      ? parameters.get('policy') === 'future'
        ? ExperimentationOptOutMode.FutureExperimentsOnly
        : ExperimentationOptOutMode.Immediate
      : ExperimentationOptOutMode.Disabled,
    flagEvaluationTrackingInterval: 1000,
    enableRumFeatureFlagTracking: false,
    proxy: ({ path, parameters }: { path: string; parameters: string }) =>
      new URL(`/intake${path}?${parameters}`, location.href).toString(),
  }
  const makeContext = (value?: unknown, targetingKey = 'subject'): EvaluationContext => ({
    targetingKey,
    country: 'US',
    ...(value === undefined ? {} : { dd_experimentation_opt_out_at: value as string }),
  })
  const initial = makeContext(optedOut ? parameters.get('cutoff') || '2026-10-19T12:00:00Z' : undefined)
  const fetchConfig = (context: EvaluationContext) =>
    fetchPrecomputedConfiguration({
      ...options,
      context,
      fetch: (_url, init) => fetch(new URL('/assignments', location.href), init),
    })
  const provider =
    mode === 'online'
      ? new DatadogProvider({
          ...options,
          flaggingProxy: new URL('/assignments', location.href).toString(),
        })
      : new DatadogCoreProvider(options)
  let tracking: DatadogTrackingHooks | undefined
  if (provider instanceof DatadogCoreProvider) {
    const rules = configurationFromString(JSON.stringify(rulesWire))
    if (parameters.get('policy') === 'future') {
      rules.rules!.response.flags['test-flag'].allocations[0].randomizationActivatedAt = {
        $typeName: 'google.protobuf.Timestamp',
        seconds: BigInt(Date.parse('2026-10-01T12:00:00Z') / 1000),
        nanos: 123456789,
      }
    }
    provider.setConfiguration(
      mode === 'rules' ? rules : configurationFromString(configurationToString(await fetchConfig(initial)))
    )
    tracking = composeDatadogTrackingHooks(
      createDatadogEvaluationLoggingHook(options),
      createDatadogExposureLoggingHook(options)
    )
    await tracking.initialize()
  }
  await OpenFeature.setProviderAndWait(provider, initial)
  const client = OpenFeature.getClient()
  if (tracking) client.addHooks(...tracking.hooks)
  const flag = mode === 'rules' ? 'test-flag' : 'boolean'
  Object.assign(globalThis, {
    experimentationTest: {
      evaluate: () => client.getBooleanDetails(flag, false),
      allTypes: () => [
        client.getBooleanValue('boolean', false),
        client.getStringValue('string', ''),
        client.getNumberValue('number', 0),
        client.getObjectValue('object', {}),
      ],
      update: async (value?: unknown, targetingKey = 'subject') => {
        const context = makeContext(value, targetingKey)
        // A failed fetch leaves the old portable snapshot available, but it must not serve a changed context.
        if (mode === 'precomputed' && provider instanceof DatadogCoreProvider) {
          try {
            provider.setConfiguration(configurationFromString(configurationToString(await fetchConfig(context))))
          } catch {}
        }
        await OpenFeature.setContext(context)
      },
      close: async () => {
        await tracking?.shutdown()
        await OpenFeature.clearProviders()
      },
    },
  })
  reportSuccess({ ready: true })
}
run().catch(reportError)
