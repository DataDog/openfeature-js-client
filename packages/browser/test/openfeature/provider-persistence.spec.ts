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
      const context = { targetingKey: 'user-1' }
      await provider.initialize(context)

      // Allow fire-and-forget persist to complete
      await flushAsync()

      // Verify flags were persisted
      const cache = new IndexedDBFlagsCache(options.clientToken)
      const stored = await cache.get(context)
      expect(stored).toBeDefined()
      expect(stored!.precomputed!.response.data.attributes.flags['string-flag'].variationValue).toBe('red')
    })

    it('should persist flags to IndexedDB after onContextChange', async () => {
      const provider = new DatadogProvider(options)
      await provider.initialize({ targetingKey: 'user-1' })

      const newContext = { targetingKey: 'user-2' }
      await provider.onContextChange({ targetingKey: 'user-1' }, newContext)

      // Allow fire-and-forget persist to complete
      await flushAsync()

      const cache = new IndexedDBFlagsCache(options.clientToken)
      const stored = await cache.get(newContext)
      expect(stored).toBeDefined()
      expect(stored!.precomputed).toBeDefined()
    })
  })

  describe('falls back to cached flags on network failure', () => {
    it('should use IndexedDB cache and enter STALE state when network fails', async () => {
      // First: seed IndexedDB with a known config
      const context = { targetingKey: 'cached-user' }
      const seedConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context,
          fetchedAt: 1731939819456,
        },
      }
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(seedConfig, context)
      await flushAsync()

      // Now create a provider with a failing fetch
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider(options)
      await provider.initialize(context)

      // Provider should be STALE (not READY) — serving cached data
      expect(provider.status).toBe(ProviderStatus.STALE)

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
      const context = { targetingKey: 'user-1' }
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
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(staleConfig, context)
      await flushAsync()

      // Create provider with working network
      const provider = new DatadogProvider(options)
      await provider.initialize(context)

      // Should use fresh network data, not stale cache
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red') // from network, not 'stale-value'
    })
  })

  describe('cache guards', () => {
    it('should NOT use cached flags when initialFlagsConfiguration is provided', async () => {
      // Seed IndexedDB with cached data
      const context = { targetingKey: 'user-1' }
      const seedConfig: FlagsConfiguration = {
        precomputed: {
          response: {
            data: {
              attributes: {
                createdAt: '0',
                flags: {
                  'string-flag': {
                    allocationKey: 'cached',
                    variationKey: 'cached',
                    variationType: 'string',
                    variationValue: 'cached-value',
                    reason: 'DEFAULT',
                    doLog: false,
                    extraLogging: {},
                  },
                },
              },
            },
          },
          context,
          fetchedAt: 0,
        },
      }
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(seedConfig, context)
      await flushAsync()

      // Provider with initialFlagsConfiguration should NOT use cached flags
      global.fetch = failingFetchMock()
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context,
          fetchedAt: Date.now(),
        },
      }
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })
      await provider.initialize(context)

      // initialFlagsConfiguration takes precedence, so STALE (fetch failed but we have initial config)
      expect([ProviderStatus.READY, ProviderStatus.STALE]).toContain(provider.status)
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      // Should use initialFlagsConfiguration (has 'red'), not cached ('cached-value')
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('should NOT use cached flags for a different context', async () => {
      // Seed IndexedDB with cached data for user-1
      const contextA = { targetingKey: 'user-1' }
      const seedConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context: contextA,
          fetchedAt: 1731939819456,
        },
      }
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(seedConfig, contextA)
      await flushAsync()

      // Initialize with a DIFFERENT context — cache should miss
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider(options)

      // Should throw because cache misses for user-2 and network fails
      await expect(provider.initialize({ targetingKey: 'user-2' })).rejects.toThrow('Network error')
    })

    it('should use cached flags when context matches', async () => {
      // Seed IndexedDB with cached data for user-1
      const context = { targetingKey: 'user-1' }
      const seedConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context,
          fetchedAt: 1731939819456,
        },
      }
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(seedConfig, context)
      await flushAsync()

      // Initialize with matching context — cache should hit
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider(options)
      await provider.initialize(context)

      expect(provider.status).toBe(ProviderStatus.STALE)
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
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

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}
