import { OpenFeature } from '@openfeature/web-sdk'
import {
  configurationFromString,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
  DatadogProvider,
  type DatadogTrackingHooksOptions,
} from '../../src/rules-based'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const baseOptions: DatadogTrackingHooksOptions = {
  clientToken: 'scope-token-a',
  applicationId: 'app-a',
  env: 'test',
  service: 'storefront',
}

describe.each(['localStorage', 'chrome'] as const)('%s exposure cache isolation', (storageKind) => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock
  const stored: Record<string, string> = {}

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    for (const key of Object.keys(stored)) delete stored[key]
    stored['unrelated-setting'] = 'preserve-me'
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
    if (storageKind === 'chrome') {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: {
          storage: {
            local: {
              get: jest.fn(async () => ({ ...stored })),
              set: jest.fn(async (entries: Record<string, string>) => {
                Object.assign(stored, entries)
              }),
              remove: jest.fn(async (keys: string[]) => {
                for (const key of keys) delete stored[key]
              }),
            },
          },
        },
      })
    }
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    globalThis.fetch = originalFetch
    Reflect.deleteProperty(globalThis, 'chrome')
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

        await evaluateWith(baseOptions)
        await evaluateWith({ ...baseOptions, ...changedOptions })
        expect(fetchMock).toHaveBeenCalledTimes(2)

        const storageKeys = Object.keys(storageKind === 'chrome' ? stored : localStorage)
        expect(storageKeys.join()).not.toContain(baseOptions.clientToken)
        expect(stored['unrelated-setting']).toBe('preserve-me')
      }
    )

    it('uses the same scope for implicit and explicit default site', async () => {
      await evaluateWith(baseOptions)
      await evaluateWith({ ...baseOptions, site: 'datadoghq.com' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    async function evaluateWith(options: DatadogTrackingHooksOptions) {
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
        const details =
          providerKind === 'core'
            ? client.getBooleanDetails('test-flag', false)
            : client.getStringDetails('string-flag', 'default')
        expect(details.errorCode).toBeUndefined()
        jest.advanceTimersByTime(31_000)
        client.clearHooks()
      } finally {
        await exposure?.shutdown()
        await OpenFeature.clearProviders()
      }
    }
  })
})
