import { LRUInMemoryAssignmentCache } from '@datadog/flagging-core'

import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'

/** A bounded in-memory exposure cache, also used to serve persisted entries. */
export default class SimpleAssignmentCache extends LRUInMemoryAssignmentCache {
  constructor() {
    super(MAX_EXPOSURE_CACHE_ENTRIES)
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
