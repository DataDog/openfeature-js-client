// structuredClone is required by fake-indexeddb but not available in jsdom
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val))
}
import 'fake-indexeddb/auto'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { IDBFactory } from 'fake-indexeddb'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'

const testConfig: FlagsConfiguration = {
  precomputed: {
    response: {
      data: {
        attributes: {
          createdAt: '1731939805123',
          flags: {
            'test-flag': {
              allocationKey: 'allocation-1',
              variationKey: 'variation-1',
              variationType: 'boolean',
              variationValue: true,
              reason: 'TARGETING_MATCH',
              doLog: true,
              extraLogging: {},
            },
          },
        },
      },
    },
    context: { targetingKey: 'user-123' },
    fetchedAt: 1731939819456,
  },
}

describe('IndexedDBFlagsCache', () => {
  let cache: IndexedDBFlagsCache

  beforeEach(() => {
    // Reset IndexedDB between tests
    globalThis.indexedDB = new IDBFactory()
    cache = new IndexedDBFlagsCache('test-client-token')
  })

  describe('get', () => {
    it('should return undefined when DB is empty', async () => {
      const result = await cache.get()
      expect(result).toBeUndefined()
    })

    it('should return undefined when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        const result = await cache.get()
        expect(result).toBeUndefined()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })

    it('should return undefined for corrupt data', async () => {
      // Write corrupt data directly
      const db = await openTestDB()
      const tx = db.transaction('configurations', 'readwrite')
      tx.objectStore('configurations').put('not valid json {{{', 'flags-config')
      await transactionComplete(tx)
      db.close()

      const result = await cache.get()
      expect(result).toBeUndefined()
    })

    it('should return undefined for data without precomputed field', async () => {
      // Write a valid JSON blob that has no precomputed field
      const db = await openTestDB()
      const tx = db.transaction('configurations', 'readwrite')
      tx.objectStore('configurations').put(JSON.stringify({ version: 1 }), 'flags-config')
      await transactionComplete(tx)
      db.close()

      const result = await cache.get()
      expect(result).toBeUndefined()
    })
  })

  describe('set', () => {
    it('should not throw when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        await expect(cache.set(testConfig)).resolves.toBeUndefined()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })
  })

  describe('round-trip', () => {
    it('should persist and retrieve a FlagsConfiguration', async () => {
      await cache.set(testConfig)
      const result = await cache.get()

      expect(result).toBeDefined()
      expect(result!.precomputed).toBeDefined()
      expect(result!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
      expect(result!.precomputed!.response.data.attributes.flags['test-flag'].reason).toBe('TARGETING_MATCH')
      expect(result!.precomputed!.context).toEqual({ targetingKey: 'user-123' })
    })

    it('should overwrite existing data on second set', async () => {
      await cache.set(testConfig)

      const updatedConfig: FlagsConfiguration = {
        precomputed: {
          response: {
            data: {
              attributes: {
                createdAt: '9999999999',
                flags: {
                  'updated-flag': {
                    allocationKey: 'alloc-2',
                    variationKey: 'var-2',
                    variationType: 'string',
                    variationValue: 'hello',
                    reason: 'DEFAULT',
                    doLog: false,
                    extraLogging: {},
                  },
                },
              },
            },
          },
          fetchedAt: 9999999999,
        },
      }
      await cache.set(updatedConfig)

      const result = await cache.get()
      expect(result!.precomputed!.response.data.attributes.flags['updated-flag'].variationValue).toBe('hello')
      expect(result!.precomputed!.response.data.attributes.flags['test-flag']).toBeUndefined()
    })
  })

  describe('clear', () => {
    it('should remove stored data', async () => {
      await cache.set(testConfig)
      expect(await cache.get()).toBeDefined()

      await cache.clear()
      expect(await cache.get()).toBeUndefined()
    })

    it('should not throw when DB is already empty', async () => {
      await expect(cache.clear()).resolves.toBeUndefined()
    })

    it('should not throw when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        await expect(cache.clear()).resolves.toBeUndefined()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })
  })

  describe('client token isolation', () => {
    it('should not share data between caches with different client tokens', async () => {
      const cacheA = new IndexedDBFlagsCache('token-aaa')
      const cacheB = new IndexedDBFlagsCache('token-bbb')

      await cacheA.set(testConfig)

      const resultA = await cacheA.get()
      const resultB = await cacheB.get()

      expect(resultA).toBeDefined()
      expect(resultA!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
      expect(resultB).toBeUndefined()
    })
  })
})

// Helpers to directly open the test DB for setup/verification
function openTestDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dd-flagging', 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('configurations')) {
        db.createObjectStore('configurations')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
