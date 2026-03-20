import { IDBFactory } from 'fake-indexeddb'
import type { ExposureEvent } from '../../../core/src/configuration/exposureEvent.types'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'

const exposureA: ExposureEvent = {
  subject: { id: 'user-1', attributes: {} },
  flag: { key: 'flag-1' },
  allocation: { key: 'alloc-1' },
  variant: { key: 'var-1' },
}

const exposureB: ExposureEvent = {
  subject: { id: 'user-2', attributes: {} },
  flag: { key: 'flag-2' },
  allocation: { key: 'alloc-2' },
  variant: { key: 'var-2' },
}

describe('IndexedDBAssignmentCache', () => {
  let cache: IndexedDBAssignmentCache

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    cache = new IndexedDBAssignmentCache('test-client-token')
  })

  describe('round-trip set/getEntries', () => {
    it('should persist entries and retrieve them', async () => {
      cache.set(exposureA)
      // Allow fire-and-forget persist to complete
      await flushAsync()

      const entries = await cache.getEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toHaveLength(2)
      expect(typeof entries[0][0]).toBe('string')
      expect(typeof entries[0][1]).toBe('string')
    })

    it('should persist multiple entries', async () => {
      cache.set(exposureA)
      cache.set(exposureB)
      await flushAsync()

      const entries = await cache.getEntries()
      expect(entries).toHaveLength(2)
    })

    it('should return empty array when no entries exist', async () => {
      const entries = await cache.getEntries()
      expect(entries).toEqual([])
    })
  })

  describe('client token isolation', () => {
    it('should not share data between caches with different client tokens', async () => {
      const cacheA = new IndexedDBAssignmentCache('token-aaa')
      const cacheB = new IndexedDBAssignmentCache('token-bbb')

      cacheA.set(exposureA)
      await flushAsync()

      const entriesA = await cacheA.getEntries()
      const entriesB = await cacheB.getEntries()

      expect(entriesA).toHaveLength(1)
      expect(entriesB).toEqual([])
    })
  })

  describe('graceful failure when IndexedDB unavailable', () => {
    it('getEntries should return empty array', async () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        const entries = await cache.getEntries()
        expect(entries).toEqual([])
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })

    it('set should not throw', () => {
      const originalIndexedDB = globalThis.indexedDB
      // @ts-expect-error — simulating unavailable IndexedDB
      delete globalThis.indexedDB
      try {
        expect(() => cache.set(exposureA)).not.toThrow()
      } finally {
        globalThis.indexedDB = originalIndexedDB
      }
    })

    it('clear should not throw', async () => {
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

  describe('has', () => {
    it('should throw because the serving store handles this', () => {
      expect(() => cache.has(exposureA)).toThrow()
    })
  })

  describe('cross-instance persistence (simulates page reload)', () => {
    it('should read entries written by a previous instance', async () => {
      cache.set(exposureA)
      cache.set(exposureB)
      await flushAsync()

      // New instance with the same token — simulates a fresh page load
      const freshCache = new IndexedDBAssignmentCache('test-client-token')
      const entries = await freshCache.getEntries()
      expect(entries).toHaveLength(2)
    })
  })

  describe('clear', () => {
    it('should remove all entries', async () => {
      cache.set(exposureA)
      await flushAsync()
      expect(await cache.getEntries()).toHaveLength(1)

      await cache.clear()
      expect(await cache.getEntries()).toEqual([])
    })

    it('should not throw when DB is already empty', async () => {
      await expect(cache.clear()).resolves.toBeUndefined()
    })
  })
})

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}
