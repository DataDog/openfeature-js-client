import {
  configurationFromString,
  configurationToString,
  evaluatePrecomputedConfiguration,
} from '@datadog/flagging-core'
import { DatadogProvider } from '../../src/openfeature/provider'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'

const context = { targetingKey: 'numeric-subject' }
const tokens = ['9007199254740993', '1e-999', '1e999', '9007199254740994', '1.20000000000000001']

describe.each(['number', 'integer', 'float'])('browser precomputed %s', (variationType) => {
  it.each(tokens)('uses the original JSON token %s for standalone fetch and the provider', async (token) => {
    const body = `{"data":{"attributes":{"createdAt":"2026-11-23T00:00:00Z","flags":{"probe":{"allocationKey":"allocation","variationKey":"variant","variationType":"${variationType}","variationValue":${token},"reason":"TARGETING_MATCH","doLog":false}}}}}`
    const fetch = jest
      .fn()
      .mockImplementation(async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    const configuration = await fetchPrecomputedConfiguration({
      clientToken: 'test-token',
      env: 'test',
      context,
      fetch,
    })
    const restored = configurationFromString(configurationToString(configuration))
    const provider = new DatadogProvider({
      clientToken: 'test-token',
      env: 'test',
      flagConfigurationFetch: fetch,
      enableExposureLogging: false,
      enableFlagEvaluationTracking: false,
      enableRumFeatureFlagTracking: false,
    })
    try {
      await provider.initialize(context)
      const results = [
        evaluatePrecomputedConfiguration(configuration, 'number', 'probe', -99.5, context),
        evaluatePrecomputedConfiguration(restored, 'number', 'probe', -99.5, context),
        provider.resolveNumberEvaluation('probe', -99.5, context, console),
      ]
      for (const result of results) {
        if (tokens.indexOf(token) < 3) {
          expect(result).toMatchObject({ value: -99.5, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' })
          expect(result.variant).toBeUndefined()
        } else {
          expect(result).toMatchObject({ value: Number(token), reason: 'TARGETING_MATCH', variant: 'variant' })
          expect(result.errorCode).toBeUndefined()
        }
      }
    } finally {
      await provider.onClose()
    }
  })
})
