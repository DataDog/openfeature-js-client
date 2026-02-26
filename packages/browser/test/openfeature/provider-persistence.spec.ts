// structuredClone is required by fake-indexeddb but not available in jsdom
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val))
}
import 'fake-indexeddb/auto'
import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { ProviderStatus } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../data/precomputed-v1.json'

describe('DatadogProvider IndexedDB persistence', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  const options: FlaggingInitConfiguration = {
    clientToken: 'xxx',
    applicationId: 'xxx',
    env: 'test',
    site: INTAKE_SITE_STAGING,
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
  }

  const successfulFetchMock = () =>
    jest.fn().mockImplementation(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'application/vnd.api+json' }),
      json: async () => precomputedResponse,
    }))

  const failingFetchMock = () =>
    jest.fn().mockImplementation(async () => {
      throw new Error('Network error')
    })

  beforeAll(() => {
    originalFetch = global.fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  beforeEach(() => {
    // Reset IndexedDB between tests
    globalThis.indexedDB = new IDBFactory()
    fetchMock = successfulFetchMock()
    global.fetch = fetchMock
  })

  describe('persists flags on successful fetch', () => {
    it('should persist flags to IndexedDB after initialize', async () => {
      const provider = new DatadogProvider(options)
      await provider.initialize({ targetingKey: 'user-1' })

      // Verify flags were persisted
      const cache = new IndexedDBFlagsCache()
      const stored = await cache.get()
      expect(stored).toBeDefined()
      expect(stored!.precomputed!.response.data.attributes.flags['string-flag'].variationValue).toBe('red')
    })

    it('should persist flags to IndexedDB after onContextChange', async () => {
      const provider = new DatadogProvider(options)
      await provider.initialize({ targetingKey: 'user-1' })

      // Clear the DB to isolate the onContextChange persistence
      const cache = new IndexedDBFlagsCache()
      await cache.clear()
      expect(await cache.get()).toBeUndefined()

      await provider.onContextChange({ targetingKey: 'user-1' }, { targetingKey: 'user-2' })

      const stored = await cache.get()
      expect(stored).toBeDefined()
      expect(stored!.precomputed).toBeDefined()
    })
  })

  describe('falls back to cached flags on network failure', () => {
    it('should use IndexedDB cache when network fails during initialize', async () => {
      // First: seed IndexedDB with a known config
      const seedConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context: { targetingKey: 'cached-user' },
          fetchedAt: 1731939819456,
        },
      }
      const cache = new IndexedDBFlagsCache()
      await cache.set(seedConfig)

      // Now create a provider with a failing fetch
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider(options)
      await provider.initialize({ targetingKey: 'new-user' })

      // Provider should be READY (not errored) thanks to cached data
      expect(provider.status).toBe(ProviderStatus.READY)

      // Evaluations should work using cached flags
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('should throw when network fails and no cache exists', async () => {
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider(options)

      await expect(provider.initialize({ targetingKey: 'new-user' })).rejects.toThrow('Network error')
    })
  })

  describe('network-first strategy', () => {
    it('should prefer fresh network data over stale IndexedDB cache', async () => {
      // Seed IndexedDB with stale data
      const staleConfig: FlagsConfiguration = {
        precomputed: {
          response: {
            data: {
              attributes: {
                createdAt: '0',
                flags: {
                  'string-flag': {
                    allocationKey: 'stale',
                    variationKey: 'stale',
                    variationType: 'string',
                    variationValue: 'stale-value',
                    reason: 'DEFAULT',
                    doLog: false,
                    extraLogging: {},
                  },
                },
              },
            },
          },
          fetchedAt: 0,
        },
      }
      const cache = new IndexedDBFlagsCache()
      await cache.set(staleConfig)

      // Create provider with working network
      const provider = new DatadogProvider(options)
      await provider.initialize({ targetingKey: 'user-1' })

      // Should use fresh network data, not stale cache
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red') // from network, not 'stale-value'
    })
  })

  describe('graceful degradation without IndexedDB', () => {
    it('should work normally when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB

      try {
        const provider = new DatadogProvider(options)
        await provider.initialize({ targetingKey: 'user-1' })

        expect(provider.status).toBe(ProviderStatus.READY)
        const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
        expect(result.value).toBe('red')
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })

    it('should still throw on network error when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB

      try {
        global.fetch = failingFetchMock()
        const provider = new DatadogProvider(options)
        await expect(provider.initialize({ targetingKey: 'user-1' })).rejects.toThrow('Network error')
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })
  })
})
