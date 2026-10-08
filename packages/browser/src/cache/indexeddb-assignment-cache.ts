import { type AssignmentCacheEntry, assignmentCacheKeyToString } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'
import { withStore } from './indexeddb-store'
import SimpleAssignmentCache from './simple-assignment-cache'

interface StoredExposures {
  generation: number
  entries: [string, string][]
}

/** Keep exposure checks synchronous. Merge pending entries into storage without blocking evaluation. */
export class IndexedDBAssignmentCache extends SimpleAssignmentCache {
  private readonly storageKey: string
  private operations: Promise<void> = Promise.resolve()
  private initialization?: Promise<void>
  private persistScheduled = false
  private generation = 0
  private storedGeneration = 0
  private pendingKeys = new Set<string>()

  constructor(storageKeySuffix: string) {
    super()
    this.storageKey = `assignments-${storageKeySuffix}`
  }

  init(): Promise<void> {
    if (!this.initialization) {
      const generation = this.generation
      this.initialization = this.enqueue(async () => {
        const stored = readStored(await withStore('readonly', (store) => store.get(this.storageKey)))
        // A clear during loading must not restore the previous configuration's exposures.
        if (generation !== this.generation) return
        this.storedGeneration = stored.generation
        const current = Array.from(this.entries())
        super.clear()
        this.setEntries(stored.entries)
        // Evaluations during loading take precedence over older persisted values.
        this.setEntries(current)
        if (stored.entries.length > MAX_EXPOSURE_CACHE_ENTRIES) this.persist()
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
    // New entries need a write after the clear, even if an older write is queued.
    this.persistScheduled = false
    return this.enqueue(async () => {
      // Keep a counter so other instances can reject their pre-clear writes.
      const stored = await this.update((current) => ({ generation: current.generation + 1, entries: [] }))
      this.storedGeneration = stored.generation
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
        const storedGeneration = this.storedGeneration
        try {
          const stored = await this.update((current) => {
            if (current.generation !== storedGeneration) return current
            // Merge only this batch's changes, never the instance's loaded snapshot.
            const merged = new Map(current.entries)
            for (const [key, value] of entries) {
              merged.delete(key)
              merged.set(key, value)
            }
            for (const key of merged.keys()) {
              if (merged.size <= MAX_EXPOSURE_CACHE_ENTRIES) break
              merged.delete(key)
            }
            return { generation: storedGeneration, entries: Array.from(merged) }
          })
          if (generation === this.generation && stored.generation !== storedGeneration) {
            // Another instance cleared the scope. Drop this batch and any queued old writes.
            // This can repeat an exposure, but cannot restore a cleared deduplication entry.
            this.generation++
            this.storedGeneration = stored.generation
            this.persistScheduled = false
            this.pendingKeys.clear()
            super.clear()
            this.setEntries(stored.entries)
          }
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

  private async update(change: (current: StoredExposures) => StoredExposures): Promise<StoredExposures> {
    let updated!: StoredExposures
    await withStore('readwrite', (store) => {
      // IndexedDB serializes these read/write transactions across connections and tabs.
      const request = store.get(this.storageKey)
      request.onsuccess = () => {
        try {
          updated = change(readStored(request.result))
          store.put(updated, this.storageKey)
        } catch {
          store.transaction.abort()
        }
      }
      return request
    })
    return updated
  }
}

function readStored(value: unknown): StoredExposures {
  // Accept snapshots written by earlier builds without an invalidation counter.
  if (Array.isArray(value)) return { generation: 0, entries: value.filter(isEntry) }
  if (
    typeof value === 'object' && value !== null &&
    'generation' in value && typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) && value.generation >= 0 &&
    'entries' in value && Array.isArray(value.entries)
  ) {
    return { generation: value.generation, entries: value.entries.filter(isEntry) }
  }
  return { generation: 0, entries: [] }
}

function isEntry(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string') && value[0] !== ''
  )
}
