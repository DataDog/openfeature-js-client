import { DatadogProvider } from '@datadog/openfeature-browser'
import {
  configurationFromString,
  createDatadogEvaluationLoggingHook,
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
  const enabled = parameters.get('tracking') !== 'false'
  const context = {
    targetingKey:
      (Reflect.get(globalThis, 'privacyTargetingKey') as string | undefined) ??
      parameters.get('key') ??
      'jane.doe@datadoghq.com',
    country: 'US',
    nested: { email: 'context-canary@example.com' },
  }
  const options = {
    clientToken: 'local-privacy-test',
    env: 'test',
    service: 'privacy-test-service',
    flagEvaluationTrackingInterval: Number(parameters.get('interval') || 60000),
    proxy: ({ path, parameters }: { path: string; parameters: string }) =>
      new URL(`/intake${path}?${parameters}`, location.href).toString(),
  }
  const client = OpenFeature.getClient()
  let online: DatadogProvider | undefined
  let core: DatadogCoreProvider | undefined
  let tracking: DatadogTrackingHooks | undefined
  const configure = async (consent: boolean) => {
    if (mode === 'rules') {
      const configuration = configurationFromString(JSON.stringify(rulesWire))
      if (!configuration.rules) throw new Error('Missing rules fixture')
      configuration.rules.response.observeFullEvaluationData = consent
      core!.setConfiguration(configuration)
    } else {
      core!.setConfiguration(
        await fetchPrecomputedConfiguration({
          ...options,
          context,
          fetch: (_url, init) => fetch(new URL('/assignments', location.href), init),
        })
      )
    }
  }
  if (mode === 'online') {
    online = new DatadogProvider({
      ...options,
      flaggingProxy: new URL('/assignments', location.href).toString(),
      enableExposureLogging: false,
      enableRumFeatureFlagTracking: false,
      enableFlagEvaluationTracking: enabled,
    })
    await OpenFeature.setProviderAndWait(online, context)
  } else {
    core = new DatadogCoreProvider()
    await configure(parameters.get('consent') === 'true')
    await OpenFeature.setProviderAndWait(core, context)
    if (enabled) {
      tracking = createDatadogEvaluationLoggingHook(options)
      await tracking.initialize()
      client.addHooks(...tracking.hooks)
    }
  }
  client.addHooks({
    before: (hookContext) => {
      if (hookContext.flagKey === 'hostile-error')
        throw Object.assign(new Error('exception-canary@example.com'), { code: 'code-canary@example.com' })
    },
  })
  Object.assign(globalThis, {
    privacyTest: {
      evaluate: () => {
        const flag = mode === 'rules' ? 'test-flag' : 'browser-flag'
        const success = client.getBooleanDetails(flag, false)
        return {
          success,
          missing: client.getBooleanDetails('missing', false),
          mismatch: client.getStringDetails(flag, 'fallback'),
          hostile: client.getBooleanDetails('hostile-error', false),
        }
      },
      refresh: async (consent: boolean) => {
        if (online) await online.onContextChange(context, context)
        else await configure(consent)
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
