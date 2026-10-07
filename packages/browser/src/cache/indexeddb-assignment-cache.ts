import type { AssignmentCacheEntry } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'
import { withStore } from './indexeddb-store'
import SimpleAssignmentCache from './simple-assignment-cache'

/** Keep exposure checks synchronous. Persist bounded snapshots without blocking evaluation. */
export class IndexedDBAssignmentCache extends SimpleAssignmentCache {
  private readonly storageKey: string
  private operations: Promise<void> = Promise.resolve()
  private initialization?: Promise<void>
  private persistScheduled = false
  private generation = 0

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
    this.persist()
  }

  clear(): Promise<void> {
    super.clear()
    this.generation++
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
    void Promise.resolve().then(() => {
      void this.enqueue(async () => {
        this.persistScheduled = false
        await withStore('readwrite', (store) => store.put(Array.from(this.entries()), this.storageKey))
      })
    })
  }
}

function isEntry(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string') && value[0] !== ''
  )
}
