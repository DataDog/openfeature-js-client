// structuredClone is required by fake-indexeddb but not available in jsdom
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val))
}
import 'fake-indexeddb/auto'

/**
 * @jest-environment jsdom
 */

import { assignmentCacheFactory } from '../../src/cache/assignment-cache-factory'
import HybridAssignmentCache from '../../src/cache/hybrid-assignment-cache'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'

describe('AssignmentCacheFactory', () => {
  it('should create a hybrid cache with IndexedDB when IndexedDB is available', () => {
    const cache = assignmentCacheFactory({
      clientToken: 'test-token',
    })
    expect(cache).toBeInstanceOf(HybridAssignmentCache)
  })

  it('should create a simple cache when IndexedDB is unavailable', () => {
    const originalIndexedDB = globalThis.indexedDB
    // @ts-expect-error — simulating unavailable IndexedDB
    delete globalThis.indexedDB
    try {
      const cache = assignmentCacheFactory({
        clientToken: 'test-token',
      })
      expect(cache).toBeInstanceOf(SimpleAssignmentCache)
    } finally {
      globalThis.indexedDB = originalIndexedDB
    }
  })

  it('should create a simple cache when forceMemoryOnly is true', () => {
    const cache = assignmentCacheFactory({
      clientToken: 'test-token',
      forceMemoryOnly: true,
    })
    expect(cache).toBeInstanceOf(SimpleAssignmentCache)
  })
})
