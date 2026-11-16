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
    // An LRU update can evict only the oldest entry; do not scan the whole cache to find it.
    const oldest = this.debug.enabled ? this.delegate.entries().next().value : undefined
    super.set(entry)
    this.debug.event('exposure.cache_recorded', () => ({
      entry,
      capacity: MAX_EXPOSURE_CACHE_ENTRIES,
      size: this.delegate.size,
      evicted: oldest && !this.delegate.has(oldest[0]) ? [oldest] : [],
    }))
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
