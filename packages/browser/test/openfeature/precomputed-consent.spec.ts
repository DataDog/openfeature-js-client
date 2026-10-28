import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { configurationFromString } from '@datadog/flagging-core'
import { ProviderEvents, ProviderStatus } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../data/precomputed-v1.json'

const metadataKey = '__dd_observe_full_evaluation_data'
const context = { targetingKey: 'consent-subject' }
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const options = {
  clientToken: 'consent-test',
  applicationId: 'test',
  env: 'test',
  site: INTAKE_SITE_STAGING,
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}

function response(consent: unknown, obfuscated: boolean) {
  return {
    data: {
      attributes: {
        ...precomputedResponse.data.attributes,
        ...(consent === undefined ? {} : { observeFullEvaluationData: consent }),
        ...(obfuscated
          ? {
              obfuscated: true,
              obfuscation: { scheme: 'flag-key-sha256-v1', salt: '000102030405060708090a0b0c0d0e0f' },
              flags: {
                a60479237ef2f69175bbe0bd581966d1583766941815dc1d414c883767795190:
                  precomputedResponse.data.attributes.flags['boolean-flag'],
              },
            }
          : {}),
      },
    },
  }
}

const originalFetch = global.fetch
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})
afterEach(() => {
  global.fetch = originalFetch
})

describe.each([false, true])('browser consent (obfuscated: %s)', (obfuscated) => {
  const flagKey = obfuscated ? 'new-route-planner' : 'boolean-flag'
  it.each([true, false, undefined, null, 'true'])(
    'retains consent %p through persistent cache and offline restart',
    async (consent) => {
      const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => response(consent, obfuscated) })
      global.fetch = fetch
      const online = new DatadogProvider(options)
      const offline = new DatadogProvider(options)
      try {
        await online.initialize(context)
        const first = online.resolveBooleanEvaluation(flagKey, false, context, logger)
        expect(first).toMatchObject({ value: true, flagMetadata: { [metadataKey]: consent === true } })
        const cache = new IndexedDBFlagsCache(options.clientToken)
        // Wait for the provider's fire-and-forget IndexedDB write.
        for (let i = 0; i < 50 && !(await cache.get(context)); i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        expect(await cache.get(context)).toBeDefined()
        await online.onClose()
        fetch.mockRejectedValue(new Error('offline'))
        await offline.initialize(context)
        expect(offline.status).toBe(ProviderStatus.STALE)
        expect(offline.resolveBooleanEvaluation(flagKey, false, context, logger)).toMatchObject({
          value: true,
          flagMetadata: { [metadataKey]: consent === true },
        })
        expect(offline.resolveBooleanEvaluation('missing', false, context, logger)).toMatchObject({
          errorCode: 'FLAG_NOT_FOUND',
          flagMetadata: { [metadataKey]: consent === true },
        })
      } finally {
        await online.onClose()
        await offline.onClose()
      }
    }
  )

  it.each([true, false])('updates consent %s on normal refresh while retaining earlier results', async (consent) => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => response(consent, obfuscated) })
    global.fetch = fetch
    const provider = new DatadogProvider(options)
    try {
      await provider.initialize(context)
      const first = provider.resolveBooleanEvaluation(flagKey, false, context, logger)
      let finish!: (value: unknown) => void
      fetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const refresh = provider.onContextChange(context, context)
      expect(provider.resolveBooleanEvaluation(flagKey, false, context, logger).flagMetadata?.[metadataKey]).toBe(
        consent
      )
      finish({ ok: true, json: async () => response(!consent, obfuscated) })
      await refresh
      const next = provider.resolveBooleanEvaluation(flagKey, false, context, logger)
      expect(next.value).toBe(first.value)
      expect(next.flagMetadata?.[metadataKey]).toBe(!consent)
      expect(first.flagMetadata?.[metadataKey]).toBe(consent)
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await provider.onClose()
    }
  })
})

it.each([true, false])('notifies core-provider consumers about a consent-only change from %s', async (consent) => {
  const provider = new DatadogCoreProvider()
  const config = (value: boolean) =>
    configurationFromString(
      JSON.stringify({ version: 1, precomputed: { context, response: JSON.stringify(response(value, false)) } })
    )
  provider.setConfiguration(config(consent))
  await provider.initialize(context)
  const changed = jest.fn()
  provider.events.addHandler(ProviderEvents.ConfigurationChanged, changed)
  const first = provider.resolveBooleanEvaluation('boolean-flag', false, context, logger)
  provider.setConfiguration(config(!consent))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(first.flagMetadata?.[metadataKey]).toBe(consent)
  expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).flagMetadata?.[metadataKey]).toBe(
    !consent
  )
})
