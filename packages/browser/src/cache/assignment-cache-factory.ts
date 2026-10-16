import type { AssignmentCache } from '@datadog/flagging-core'
import { hasIndexedDB } from './helpers'
import { IndexedDBAssignmentCache } from './indexeddb-assignment-cache'
import SimpleAssignmentCache from './simple-assignment-cache'

export function assignmentCacheFactory({
  forceMemoryOnly = false,
  storageKeySuffix,
}: {
  forceMemoryOnly?: boolean
  storageKeySuffix: string
}): AssignmentCache {
  return !forceMemoryOnly && hasIndexedDB()
    ? new IndexedDBAssignmentCache(storageKeySuffix)
    : new SimpleAssignmentCache()
}
