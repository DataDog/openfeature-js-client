import { OpenFeature } from '@openfeature/web-sdk'
import { withStore } from '../../src/cache/indexeddb-store'
import {
  configurationFromString,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
  DatadogProvider,
  type DatadogTrackingHooksOptions,
} from '../../src/rules-based'
import { nextWrite } from '../cache/indexeddb-test-helpers'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const baseOptions: DatadogTrackingHooksOptions = {
  clientToken: 'scope-token-a',
  applicationId: 'app-a',
  env: 'test',
  service: 'storefront',
}

describe('IndexedDB exposure cache isolation', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  describe.each(['core', 'online'] as const)('%s provider', (providerKind) => {
    it.each([
      ['client token', { clientToken: 'scope-token-b' }],
      ['application', { applicationId: 'app-b' }],
      ['environment', { env: 'production' }],
      ['site', { site: 'datadoghq.eu' }],
      ['service', { service: 'checkout' }],
      ['proxy', { proxy: 'https://proxy.example.com/intake' }],
      ['source', { source: 'flutter' }],
    ] satisfies [string, Partial<DatadogTrackingHooksOptions>][])(
      'isolates %s and retains deduplication when each scope is recreated',
      async (_name, changedOptions) => {
        await evaluateWith(baseOptions)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await evaluateWith({ ...baseOptions, ...changedOptions })
        expect(fetchMock).toHaveBeenCalledTimes(2)

        await evaluateWith(baseOptions, false)
        await evaluateWith({ ...baseOptions, ...changedOptions }, false)
        expect(fetchMock).toHaveBeenCalledTimes(2)

        const storageKeys = await withStore('readonly', (store) => store.getAllKeys())
        expect(storageKeys.join()).not.toContain(baseOptions.clientToken)
      }
    )

    it('uses the same scope for implicit and explicit default site', async () => {
      await evaluateWith(baseOptions)
      await evaluateWith({ ...baseOptions, site: 'datadoghq.com' }, false)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    async function evaluateWith(options: DatadogTrackingHooksOptions, expectExposure = true) {
      const exposure = providerKind === 'core' ? createDatadogExposureLoggingHook(options) : undefined
      try {
        let provider: DatadogCoreProvider | DatadogProvider
        if (providerKind === 'core') {
          provider = new DatadogCoreProvider()
          provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
          await exposure!.initialize()
        } else {
          provider = new DatadogProvider({
            ...options,
            enableFlagEvaluationTracking: false,
            enableRumFeatureFlagTracking: false,
            flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
          })
        }
        await OpenFeature.setProviderAndWait('cache-scope', provider, { targetingKey: 'user', country: 'US' })
        const client = OpenFeature.getClient('cache-scope')
        if (exposure) client.addHooks(...exposure.hooks)
        const written = expectExposure ? nextWrite() : undefined
        const details =
          providerKind === 'core'
            ? client.getBooleanDetails('test-flag', false)
            : client.getStringDetails('string-flag', 'default')
        expect(details.errorCode).toBeUndefined()
        jest.advanceTimersByTime(31_000)
        client.clearHooks()
        await written
      } finally {
        await exposure?.shutdown()
        await OpenFeature.clearProviders()
      }
    }
  })
})
