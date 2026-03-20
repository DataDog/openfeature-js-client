import type { AssignmentCache } from '@datadog/flagging-core'
import { hasIndexedDB } from './helpers'
import HybridAssignmentCache from './hybrid-assignment-cache'
import { IndexedDBAssignmentCache } from './indexeddb-assignment-cache'
import SimpleAssignmentCache from './simple-assignment-cache'

export function assignmentCacheFactory({
  forceMemoryOnly = false,
  clientToken,
}: {
  forceMemoryOnly?: boolean
  clientToken: string
}): AssignmentCache {
  const simpleCache = new SimpleAssignmentCache()

  if (forceMemoryOnly) {
    return simpleCache
  }

  if (hasIndexedDB()) {
    const indexedDBCache = new IndexedDBAssignmentCache(clientToken)
    return new HybridAssignmentCache(simpleCache, indexedDBCache)
  }

  return simpleCache
}
