import type { AssignmentCache } from '@datadog/flagging-core'
import { type DebugLogger, NO_DEBUG } from '../debug'
import { hasIndexedDB } from './helpers'
import { IndexedDBAssignmentCache } from './indexeddb-assignment-cache'
import SimpleAssignmentCache from './simple-assignment-cache'

export function assignmentCacheFactory({
  forceMemoryOnly = false,
  storageKeySuffix,
  debug = NO_DEBUG,
}: {
  forceMemoryOnly?: boolean
  storageKeySuffix: string
  debug?: DebugLogger
}): AssignmentCache {
  const persistent = !forceMemoryOnly && hasIndexedDB()
  debug.event('cache.configured', () => ({
    cache: 'exposures',
    backend: persistent ? 'indexeddb' : 'memory',
    scope: storageKeySuffix,
    forceMemoryOnly,
  }))
  return persistent ? new IndexedDBAssignmentCache(storageKeySuffix, debug) : new SimpleAssignmentCache(debug)
}
