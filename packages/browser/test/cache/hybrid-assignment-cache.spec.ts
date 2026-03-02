import { IDBFactory } from 'fake-indexeddb'
import type { ExposureEvent } from '../../../core/src/configuration/exposureEvent.types'
import HybridAssignmentCache from '../../src/cache/hybrid-assignment-cache'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'

describe('HybridStorageAssignmentCache', () => {
  let servingCache: SimpleAssignmentCache
  let persistentCache: IndexedDBAssignmentCache
  let hybridCache: HybridAssignmentCache

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    servingCache = new SimpleAssignmentCache()
    persistentCache = new IndexedDBAssignmentCache('test-token')
    hybridCache = new HybridAssignmentCache(servingCache, persistentCache)
  })

  it('has should return false if cache is empty', async () => {
    const exposureEvent: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    await hybridCache.init()
    expect(hybridCache.has(exposureEvent)).toBeFalsy()
  })

  it('has should return true if cache key is present', async () => {
    const exposureEvent: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    await hybridCache.init()
    expect(hybridCache.has(exposureEvent)).toBeFalsy()
    expect(servingCache.has(exposureEvent)).toBeFalsy()
    hybridCache.set(exposureEvent)
    expect(hybridCache.has(exposureEvent)).toBeTruthy()
    expect(servingCache.has(exposureEvent)).toBeTruthy()
  })

  it('should populate serving cache from persistent cache on init', async () => {
    const exposureEvent1: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'allocation-1' },
      variant: { key: 'control' },
    }
    const exposureEvent2: ExposureEvent = {
      subject: { id: 'subject-2', attributes: {} },
      flag: { key: 'flag-2' },
      allocation: { key: 'allocation-2' },
      variant: { key: 'control' },
    }
    const exposureEvent3: ExposureEvent = {
      subject: { id: 'subject-1', attributes: {} },
      flag: { key: 'flag-1' },
      allocation: { key: 'foo' },
      variant: { key: 'control' },
    }

    // Write entries directly to the persistent store
    persistentCache.set(exposureEvent1)
    persistentCache.set(exposureEvent2)
    // Allow fire-and-forget persist to complete
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Init should hydrate the serving cache from the persistent store
    await hybridCache.init()
    expect(servingCache.has(exposureEvent1)).toBeTruthy()
    expect(servingCache.has(exposureEvent2)).toBeTruthy()
    expect(servingCache.has(exposureEvent3)).toBeFalsy()
  })
})
