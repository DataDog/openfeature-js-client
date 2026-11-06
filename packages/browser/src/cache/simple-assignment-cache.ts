import { type AssignmentCacheEntry, LRUInMemoryAssignmentCache } from '@datadog/flagging-core'

import { type DebugLogger, NO_DEBUG } from '../debug'
import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'

/** A bounded in-memory exposure cache, also used to serve persisted entries. */
export default class SimpleAssignmentCache extends LRUInMemoryAssignmentCache {
  constructor(protected readonly debug: DebugLogger = NO_DEBUG) {
    super(MAX_EXPOSURE_CACHE_ENTRIES)
  }

  has(entry: AssignmentCacheEntry): boolean {
    const hit = super.has(entry)
    this.debug.event('exposure.cache_checked', () => ({ entry, hit }))
    return hit
  }

  set(entry: AssignmentCacheEntry): void {
    const before = this.debug.enabled ? Array.from(this.entries()) : undefined
    super.set(entry)
    this.debug.event('exposure.cache_recorded', () => {
      const after = new Map(this.entries())
      return {
        entry,
        capacity: MAX_EXPOSURE_CACHE_ENTRIES,
        size: after.size,
        evicted: before?.filter(([key]) => !after.has(key)),
      }
    })
  }

  clear(): void {
    this.debug.event('exposure.cache_cleared', () => ({ entries: Array.from(this.entries()) }))
    super.clear()
  }

  setEntries(entries: [string, string][]): void {
    // Load serialized entries through the same capacity limit as new exposures.
    entries.forEach(([key, value]) => {
      this.delegate.set(key, value)
    })
  }

  getEntries(): Promise<[string, string][]> {
    return Promise.resolve(Array.from(this.entries()))
  }
}
