// structuredClone is required by fake-indexeddb but not available in jsdom
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val))
}
import 'fake-indexeddb/auto'
import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/configuration'
import type { TimeStamp } from '@datadog/js-core/time'
import { timeStampNow } from '@datadog/js-core/time'
import { ProviderStatus } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

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
          fetchedAt: 1731939819456 as TimeStamp,
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
                  },
                },
              },
            },
          },
          fetchedAt: 0 as TimeStamp,
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
                  },
                },
              },
            },
          },
          context,
          fetchedAt: 0 as TimeStamp,
        },
      }
      const cache = new IndexedDBFlagsCache(options.clientToken)
      cache.set(seedConfig, context)
      await flushAsync()

      // Provider with initialFlagsConfiguration should NOT use cached flags
      const initialFetch = failingFetchMock()
      global.fetch = initialFetch
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context,
          fetchedAt: timeStampNow(),
        },
      }
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })
      await provider.initialize(context)

      expect(provider.status).toBe(ProviderStatus.READY)
      expect(initialFetch).not.toHaveBeenCalled()
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
          fetchedAt: 1731939819456 as TimeStamp,
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
          fetchedAt: 1731939819456 as TimeStamp,
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

  describe('context matching with initialFlagsConfiguration', () => {
    it('should use initialFlagsConfiguration when context matches during initialize', async () => {
      const context = { targetingKey: 'user-1', customAttribute: 'value' }
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context,
          fetchedAt: timeStampNow(),
        },
      }

      const initialFetch = failingFetchMock()
      global.fetch = initialFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })
      await provider.initialize(context)

      expect(provider.status).toBe(ProviderStatus.READY)
      expect(initialFetch).not.toHaveBeenCalled()
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('should NOT use initialFlagsConfiguration when context does not match during initialize', async () => {
      const initialContext = { targetingKey: 'user-1' }
      const requestContext = { targetingKey: 'user-2' }
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context: initialContext,
          fetchedAt: timeStampNow(),
        },
      }

      const initialFetch = failingFetchMock()
      global.fetch = initialFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })

      // Should throw because context doesn't match and no cache exists
      await expect(provider.initialize(requestContext)).rejects.toThrow('Network error')
      expect(initialFetch).toHaveBeenCalledTimes(1)
    })

    it('should use context-agnostic initialFlagsConfiguration (no context field)', async () => {
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          // No context field = matches any context
          fetchedAt: timeStampNow(),
        },
      }

      const initialFetch = failingFetchMock()
      global.fetch = initialFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })
      await provider.initialize({ targetingKey: 'any-user' })

      expect(provider.status).toBe(ProviderStatus.READY)
      expect(initialFetch).not.toHaveBeenCalled()
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('should reuse current configuration on context change when context still matches', async () => {
      const context = { targetingKey: 'user-1' }

      // Initialize successfully for user-1
      fetchMock = successfulFetchMock()
      global.fetch = fetchMock

      const provider = new DatadogProvider(options)
      await provider.initialize(context)
      expect(provider.status).toBe(ProviderStatus.READY)

      // Context change to same context, but fetch fails
      // Should reuse current config and go STALE
      global.fetch = failingFetchMock()
      await provider.onContextChange(context, context)

      expect(provider.status).toBe(ProviderStatus.STALE)
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('should reuse context-agnostic current configuration on any context change', async () => {
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          // No context = matches any context
          fetchedAt: timeStampNow(),
        },
      }

      // Initialize with context-agnostic config
      global.fetch = failingFetchMock()
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })
      await provider.initialize({ targetingKey: 'user-1' })
      expect(provider.status).toBe(ProviderStatus.READY)

      // Context change to different user, fetch still fails
      // Should reuse context-agnostic config and stay STALE
      await provider.onContextChange({ targetingKey: 'user-1' }, { targetingKey: 'user-2' })

      expect(provider.status).toBe(ProviderStatus.STALE)
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      const result = provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger)
      expect(result.value).toBe('red')
    })

    it('adopts an embedded precomputed context when initialized with an empty context', async () => {
      const embeddedContext = { targetingKey: 'embedded-user' }
      const initialConfig: FlagsConfiguration = {
        precomputed: {
          response: precomputedResponse as any,
          context: embeddedContext,
          fetchedAt: timeStampNow(),
        },
      }
      const initialFetch = failingFetchMock()
      global.fetch = initialFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: initialConfig })

      await provider.initialize({})

      expect(provider.status).toBe(ProviderStatus.READY)
      expect(initialFetch).not.toHaveBeenCalled()
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      expect(provider.resolveStringEvaluation('string-flag', 'default', {}, mockLogger).value).toBe('red')
    })

    it('uses rules bootstrap locally, then retains it after fetching precomputed flags', async () => {
      const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))
      const initialFetch = successfulFetchMock()
      global.fetch = initialFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: rulesConfiguration })
      const initialContext = { targetingKey: 'user-1', country: 'US' }
      const nextContext = { targetingKey: 'user-1', country: 'US', plan: 'paid' }
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

      await provider.initialize(initialContext)

      expect(initialFetch).not.toHaveBeenCalled()
      expect(provider.resolveBooleanEvaluation('test-flag', false, initialContext, mockLogger).value).toBe(true)

      await provider.onContextChange(initialContext, nextContext)

      expect(initialFetch).toHaveBeenCalledTimes(1)
      expect(provider.resolveStringEvaluation('string-flag', 'default', nextContext, mockLogger).value).toBe('red')
      expect(provider.resolveBooleanEvaluation('test-flag', false, initialContext, mockLogger).value).toBe(true)
    })

    it('keeps evaluating rules when a later precomputed fetch fails', async () => {
      const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))
      const failedFetch = failingFetchMock()
      global.fetch = failedFetch
      const provider = new DatadogProvider({ ...options, initialFlagsConfiguration: rulesConfiguration })
      const initialContext = { targetingKey: 'user-1', country: 'US' }
      const nextContext = { ...initialContext, plan: 'paid' }
      const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

      await provider.initialize(initialContext)
      await provider.onContextChange(initialContext, nextContext)

      expect(failedFetch).toHaveBeenCalledTimes(1)
      expect(provider.status).toBe(ProviderStatus.STALE)
      expect(provider.resolveBooleanEvaluation('test-flag', false, nextContext, mockLogger).value).toBe(true)
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
