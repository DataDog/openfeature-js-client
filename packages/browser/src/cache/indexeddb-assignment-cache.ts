import { type AssignmentCacheEntry, assignmentCacheKeyToString } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'
import { withStore } from './indexeddb-store'
import SimpleAssignmentCache from './simple-assignment-cache'

/** Keep exposure checks synchronous. Merge pending entries into storage without blocking evaluation. */
export class IndexedDBAssignmentCache extends SimpleAssignmentCache {
  private readonly storageKey: string
  private operations: Promise<void> = Promise.resolve()
  private initialization?: Promise<void>
  private persistScheduled = false
  private generation = 0
  private pendingKeys = new Set<string>()

  constructor(storageKeySuffix: string) {
    super()
    this.storageKey = `assignments-${storageKeySuffix}`
  }

  init(): Promise<void> {
    if (!this.initialization) {
      const generation = this.generation
      this.initialization = this.enqueue(async () => {
        const stored: unknown = await withStore('readonly', (store) => store.get(this.storageKey))
        // A clear during loading must not restore the previous configuration's exposures.
        if (generation !== this.generation || !Array.isArray(stored)) return
        const current = Array.from(this.entries())
        super.clear()
        this.setEntries(stored.filter(isEntry))
        // Evaluations during loading take precedence over older persisted values.
        this.setEntries(current)
        if (stored.length > MAX_EXPOSURE_CACHE_ENTRIES) this.persist()
      })
    }
    return this.initialization
  }

  set(entry: AssignmentCacheEntry): void {
    void this.init()
    super.set(entry)
    const key = assignmentCacheKeyToString(entry)
    this.pendingKeys.delete(key)
    this.pendingKeys.add(key)
    // Keep the pending key index bounded even if storage is unavailable.
    if (this.pendingKeys.size > MAX_EXPOSURE_CACHE_ENTRIES) {
      this.pendingKeys.delete(this.pendingKeys.values().next().value!)
    }
    this.persist()
  }

  clear(): Promise<void> {
    super.clear()
    this.generation++
    this.pendingKeys.clear()
    // New entries need a write after the delete, even if an older write is queued.
    this.persistScheduled = false
    return this.enqueue(async () => {
      await withStore('readwrite', (store) => store.delete(this.storageKey))
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.operations = this.operations.then(operation).catch(() => {
      // Storage failures must not stop evaluation or later persistence attempts.
    })
    return this.operations
  }

  private persist(): void {
    if (this.persistScheduled) return
    this.persistScheduled = true
    const generation = this.generation
    void Promise.resolve().then(() => {
      void this.enqueue(async () => {
        // A queued write from before clear must not consume post-clear entries.
        if (generation !== this.generation) return
        this.persistScheduled = false
        const pendingKeys = this.pendingKeys
        this.pendingKeys = new Set()
        const entries = Array.from(this.entries()).filter(([key]) => pendingKeys.has(key))
        try {
          await withStore('readwrite', (store) => {
            // IndexedDB serializes read/write transactions across connections and tabs.
            // Merge only this batch's changes, never the instance's stale loaded snapshot.
            const request = store.get(this.storageKey)
            request.onsuccess = () => {
              try {
                const stored = new Map<string, string>(
                  Array.isArray(request.result) ? request.result.filter(isEntry) : []
                )
                for (const [key, value] of entries) {
                  stored.delete(key)
                  stored.set(key, value)
                }
                for (const key of stored.keys()) {
                  if (stored.size <= MAX_EXPOSURE_CACHE_ENTRIES) break
                  stored.delete(key)
                }
                store.put(Array.from(stored), this.storageKey)
              } catch {
                // Exceptions in a request callback must abort the whole merge.
                store.transaction.abort()
              }
            }
            return request
          })
        } catch {
          if (generation === this.generation) {
            // Retry failed entries on a later write, retaining only keys still in memory.
            // Read their current values then, so retries cannot overwrite newer assignments.
            const newerKeys = this.pendingKeys
            this.pendingKeys = new Set()
            for (const [key] of this.entries()) {
              if (pendingKeys.has(key) || newerKeys.has(key)) this.pendingKeys.add(key)
            }
          }
        }
      })
    })
  }
}

function isEntry(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string') && value[0] !== ''
  )
}
