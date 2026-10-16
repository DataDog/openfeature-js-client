import { assignmentCacheFactory } from '../../src/cache/assignment-cache-factory'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'

describe('assignmentCacheFactory', () => {
  it('uses IndexedDB when available', () => {
    expect(assignmentCacheFactory({ storageKeySuffix: 'scope' })).toBeInstanceOf(IndexedDBAssignmentCache)
  })

  it('uses memory when IndexedDB is unavailable', () => {
    const original = globalThis.indexedDB
    // @ts-expect-error Simulate unavailable browser storage.
    delete globalThis.indexedDB
    try {
      const cache = assignmentCacheFactory({ storageKeySuffix: 'scope' })
      expect(cache).toBeInstanceOf(SimpleAssignmentCache)
      expect(cache).not.toBeInstanceOf(IndexedDBAssignmentCache)
    } finally {
      globalThis.indexedDB = original
    }
  })

  it('uses memory when explicitly requested', () => {
    const cache = assignmentCacheFactory({ storageKeySuffix: 'scope', forceMemoryOnly: true })
    expect(cache).toBeInstanceOf(SimpleAssignmentCache)
    expect(cache).not.toBeInstanceOf(IndexedDBAssignmentCache)
  })
})
