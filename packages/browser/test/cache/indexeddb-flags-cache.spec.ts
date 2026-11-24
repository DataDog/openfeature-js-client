import { webcrypto } from 'node:crypto'
import { TextEncoder } from 'node:util'
import {
  buildStorageKeySuffix,
  configurationFromString,
  evaluatePrecomputedConfiguration,
  type FlagsConfiguration,
  getMD5Hash,
} from '@datadog/flagging-core'
import type { TimeStamp } from '@datadog/js-core/time'
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
            },
          },
        },
      },
    },
    context: { targetingKey: 'user-123' },
    fetchedAt: 1731939819456 as TimeStamp,
  },
}

const context = { targetingKey: 'user-123' }
const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
const previousTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder')
const cryptoBridge = {
  getRandomValues: (array: Uint8Array) => {
    array.set(webcrypto.getRandomValues(Buffer.alloc(array.length)))
    return array
  },
  subtle: {
    digest: (algorithm: AlgorithmIdentifier, data: ArrayBuffer) =>
      webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(data))),
  },
}
const legacyKey = `flags-config-${buildStorageKeySuffix('test-client-token')}-${getMD5Hash(JSON.stringify(context))}`
const previousKey = `v3-${legacyKey}`
const olderKey = `v2-${legacyKey}`
const currentKey = `v4-${legacyKey}`
const encodedConfig: FlagsConfiguration = {
  precomputed: {
    ...testConfig.precomputed!,
    response: {
      data: {
        attributes: {
          ...testConfig.precomputed!.response.data.attributes,
          obfuscated: true,
          obfuscation: { scheme: 'flag-key-sha256-v1', salt: '0'.repeat(32) },
          flags: { ['a'.repeat(64)]: testConfig.precomputed!.response.data.attributes.flags['test-flag'] },
        },
      },
    },
  },
}

describe('IndexedDBFlagsCache', () => {
  let cache: IndexedDBFlagsCache

  beforeEach(() => {
    // Reset IndexedDB between tests
    globalThis.indexedDB = new IDBFactory()
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder })
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoBridge })
    cache = new IndexedDBFlagsCache('test-client-token')
  })

  afterEach(() => {
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto)
    else Reflect.deleteProperty(globalThis, 'crypto')
    if (previousTextEncoder) Object.defineProperty(globalThis, 'TextEncoder', previousTextEncoder)
    else Reflect.deleteProperty(globalThis, 'TextEncoder')
  })

  describe('get', () => {
    it('should return undefined when DB is empty', async () => {
      const result = await cache.get(context)
      expect(result).toBeUndefined()
    })

    it('should return undefined when IndexedDB is unavailable', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        const result = await cache.get(context)
        expect(result).toBeUndefined()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })

    it('should return undefined for non-object data', async () => {
      // Write a string directly — not a FlagsConfiguration object
      const db = await openTestDB()
      const tx = db.transaction('configurations', 'readwrite')
      tx.objectStore('configurations').put('not an object', currentKey)
      await transactionComplete(tx)
      db.close()

      const result = await cache.get(context)
      expect(result).toBeUndefined()
    })

    it('should return undefined for data without precomputed field', async () => {
      // Write an object that has no precomputed field
      const db = await openTestDB()
      const tx = db.transaction('configurations', 'readwrite')
      tx.objectStore('configurations').put({ version: 1 }, currentKey)
      await transactionComplete(tx)
      db.close()

      const result = await cache.get(context)
      expect(result).toBeUndefined()
    })
  })

  describe('set', () => {
    it('should not throw when IndexedDB is unavailable', () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        expect(() => cache.set(testConfig, context)).not.toThrow()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })
  })

  describe('round-trip', () => {
    it('should persist and retrieve a FlagsConfiguration', async () => {
      cache.set(testConfig, context)
      await flushAsync()
      const result = await cache.get(context)

      expect(result).toBeDefined()
      expect(result!.precomputed).toBeDefined()
      expect(result!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
      expect(result!.precomputed!.response.data.attributes.flags['test-flag'].reason).toBe('TARGETING_MATCH')
      expect(result!.precomputed!.context).toEqual({ targetingKey: 'user-123' })
    })

    it('should overwrite existing data on second set', async () => {
      cache.set(testConfig, context)
      await flushAsync()

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
                  },
                },
              },
            },
          },
          fetchedAt: 9999999999 as TimeStamp,
        },
      }
      cache.set(updatedConfig, context)
      await flushAsync()

      const result = await cache.get(context)
      expect(result!.precomputed!.response.data.attributes.flags['updated-flag'].variationValue).toBe('hello')
      expect(result!.precomputed!.response.data.attributes.flags['test-flag']).toBeUndefined()
    })
  })

  describe('older SDK compatibility', () => {
    it('still reads the v2 namespace when v4 and v3 are empty', async () => {
      await writeEntry(olderKey, testConfig)
      expect(await cache.get(context)).toEqual(testConfig)
    })

    it('prefers v3 over v2 on upgrade', async () => {
      await writeEntry(olderKey, testConfig)
      await writeEntry(previousKey, encodedConfig)
      expect(await cache.get(context)).toEqual(encodedConfig)
    })

    it.each([false, true])('isolates rejected numeric sources from older readers (scoped: %s)', async (scoped) => {
      const numericCache = scoped
        ? new IndexedDBFlagsCache('test-client-token', undefined, async () => 'signed-v1')
        : cache
      const response = JSON.stringify(testConfig.precomputed!.response).replace(
        '"variationType":"boolean","variationValue":true',
        '"variationType":"number","variationValue":1e999'
      )
      const configuration = configurationFromString(JSON.stringify({ version: 1, precomputed: { context, response } }))
      numericCache.set(configuration, context)
      await flushAsync()
      const restored = await numericCache.get(context)
      expect(restored!.precomputed!.invalidNumericSources).toEqual({ 'test-flag': '1e999' })
      expect(evaluatePrecomputedConfiguration(restored, 'number', 'test-flag', -99.5, context)).toMatchObject({
        value: -99.5,
        reason: 'ERROR',
        errorCode: 'TYPE_MISMATCH',
      })
      const key = async (version: 'v2' | 'v3' | 'v4') =>
        scoped
          ? (
              numericCache as unknown as {
                scopedKey(
                  namespace: string,
                  contextValue: typeof context,
                  optedOut: false,
                  version: 'v2' | 'v3' | 'v4'
                ): Promise<string>
              }
            ).scopedKey('signed-v1', context, false, version)
          : `${version}-${legacyKey}`
      expect(await readEntry(await key('v4'))).toEqual(restored)
      expect(await readEntry(await key('v3'))).toBeUndefined()
      expect(await readEntry(await key('v2'))).toBeUndefined()
      expect(await readEntry(legacyKey)).toBeUndefined()
    })
    it('reads the previous cache namespace without writing new snapshots into it', async () => {
      await writeEntry(previousKey, testConfig)
      expect(await cache.get(context)).toEqual(testConfig)

      cache.set(encodedConfig, context)
      await flushAsync()
      expect(await readEntry(currentKey)).toEqual(encodedConfig)
      expect(await readEntry(previousKey)).toEqual(testConfig)
    })

    it.each(['v3', 'v2'] as const)(
      'reads the %s scoped namespace while rejecting unscoped fallback',
      async (version) => {
        const signingNamespace = async () => 'signed-v1'
        const signedCache = new IndexedDBFlagsCache('test-client-token', undefined, signingNamespace)
        const scopedKey = await (
          signedCache as unknown as {
            scopedKey(
              namespace: string,
              contextValue: typeof context,
              optedOut: false,
              version: 'v2' | 'v3'
            ): Promise<string>
          }
        ).scopedKey('signed-v1', context, false, version)

        await writeEntry(previousKey, encodedConfig)
        expect(await signedCache.get(context)).toBeUndefined()

        await writeEntry(scopedKey, testConfig)
        expect(await signedCache.get(context)).toEqual(testConfig)
      }
    )

    it('reads legacy plaintext on upgrade without overwriting it with encoded keys', async () => {
      await writeEntry(legacyKey, testConfig)
      expect(await cache.get(context)).toEqual(testConfig)

      cache.set(encodedConfig, context)
      await flushAsync()
      expect(await cache.get(context)).toEqual(encodedConfig)
      expect(await readEntry(currentKey)).toEqual(encodedConfig)
      expect(await readEntry(legacyKey)).toEqual(testConfig)
    })

    it('never writes encoded snapshots where an older SDK can read them', async () => {
      cache.set(encodedConfig, context)
      await flushAsync()
      expect(await readEntry(currentKey)).toEqual(encodedConfig)
      expect(await readEntry(previousKey)).toBeUndefined()
      expect(await readEntry(legacyKey)).toBeUndefined()
    })

    it('replaces encoded snapshots with plaintext on rollout rollback', async () => {
      cache.set(encodedConfig, context)
      await flushAsync()
      cache.set(testConfig, context)
      await flushAsync()
      expect(await cache.get(context)).toEqual(testConfig)
      expect(await readEntry(currentKey)).toEqual(testConfig)
      expect(await readEntry(legacyKey)).toBeUndefined()
    })

    it('does not restore encoded snapshots from the legacy namespace', async () => {
      await writeEntry(legacyKey, encodedConfig)
      expect(await cache.get(context)).toBeUndefined()
    })
  })

  describe('client token isolation', () => {
    it('should not share data between caches with different client tokens', async () => {
      const cacheA = new IndexedDBFlagsCache('token-aaa')
      const cacheB = new IndexedDBFlagsCache('token-bbb')

      cacheA.set(testConfig, context)
      await flushAsync()

      const resultA = await cacheA.get(context)
      const resultB = await cacheB.get(context)

      expect(resultA).toBeDefined()
      expect(resultA!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
      expect(resultB).toBeUndefined()
    })
  })

  describe('flag selection isolation', () => {
    const checkout = { tags: ['checkout'], keyPatterns: [] }
    const search = { tags: ['search'], keyPatterns: [] }

    it('uses different keys for different selections', async () => {
      new IndexedDBFlagsCache('test-client-token', checkout).set(testConfig, context)
      await flushAsync()

      expect(await new IndexedDBFlagsCache('test-client-token', checkout).get(context)).toEqual(testConfig)
      expect(await new IndexedDBFlagsCache('test-client-token', search).get(context)).toBeUndefined()
      expect(await cache.get(context)).toBeUndefined()
      expect(await readEntry(currentKey)).toBeUndefined()
    })

    it('keeps the unselected key unchanged', async () => {
      new IndexedDBFlagsCache('test-client-token', undefined).set(testConfig, context)
      await flushAsync()

      expect(await readEntry(currentKey)).toEqual(testConfig)
      expect(await new IndexedDBFlagsCache('test-client-token', checkout).get(context)).toBeUndefined()
    })

    it('does not read legacy entries, which predate selections', async () => {
      await writeEntry(legacyKey, testConfig)
      expect(await new IndexedDBFlagsCache('test-client-token', checkout).get(context)).toBeUndefined()
    })
  })

  describe('context isolation', () => {
    it('should not share data between different contexts', async () => {
      const contextA = { targetingKey: 'user-a' }
      const contextB = { targetingKey: 'user-b' }

      cache.set(testConfig, contextA)
      await flushAsync()

      expect(await cache.get(contextA)).toBeDefined()
      expect(await cache.get(contextB)).toBeUndefined()
    })

    it('should store separate configs per context', async () => {
      const contextA = { targetingKey: 'user-a' }
      const contextB = { targetingKey: 'user-b' }

      const configB: FlagsConfiguration = {
        precomputed: {
          response: {
            data: {
              attributes: {
                createdAt: '999',
                flags: {
                  'other-flag': {
                    allocationKey: 'alloc-b',
                    variationKey: 'var-b',
                    variationType: 'string',
                    variationValue: 'b-value',
                    reason: 'DEFAULT',
                    doLog: false,
                  },
                },
              },
            },
          },
          fetchedAt: 999 as TimeStamp,
        },
      }

      cache.set(testConfig, contextA)
      cache.set(configB, contextB)
      await flushAsync()

      const resultA = await cache.get(contextA)
      const resultB = await cache.get(contextB)

      expect(resultA!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
      expect(resultB!.precomputed!.response.data.attributes.flags['other-flag'].variationValue).toBe('b-value')
    })

    it('should treat contexts with reordered keys as the same', async () => {
      const contextAB = { targetingKey: 'user-1', role: 'admin' }
      const contextBA = { role: 'admin', targetingKey: 'user-1' }

      cache.set(testConfig, contextAB)
      await flushAsync()

      // Reading with reordered keys should still hit the same cache entry
      const result = await cache.get(contextBA)
      expect(result).toBeDefined()
      expect(result!.precomputed!.response.data.attributes.flags['test-flag'].variationValue).toBe(true)
    })
  })
})

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

async function writeEntry(key: string, value: FlagsConfiguration): Promise<void> {
  const db = await openTestDB()
  const tx = db.transaction('configurations', 'readwrite')
  tx.objectStore('configurations').put(value, key)
  await transactionComplete(tx)
  db.close()
}

async function readEntry(key: string): Promise<FlagsConfiguration | undefined> {
  const db = await openTestDB()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('configurations', 'readonly').objectStore('configurations').get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

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
