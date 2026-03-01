import {
  type AssignmentCacheEntry,
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
  buildStorageKeySuffix,
} from '@datadog/flagging-core'

import type { BulkReadAssignmentCache } from './hybrid-assignment-cache'

const DB_NAME = 'dd-flagging'
const DB_VERSION = 1
const STORE_NAME = 'configurations'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export class IndexedDBAssignmentCache implements BulkReadAssignmentCache {
  private readonly storageKey: string
  private readonly mirror: Map<string, string> = new Map()

  constructor(clientToken: string) {
    this.storageKey = `assignments-${buildStorageKeySuffix(clientToken)}`
  }

  /** No-op — IndexedDB entries are loaded lazily via getEntries(). */
  init(): Promise<void> {
    return Promise.resolve()
  }

  /** Fire-and-forget persist to IndexedDB. Never blocks the caller, never throws. */
  set(entry: AssignmentCacheEntry): void {
    const key = assignmentCacheKeyToString(entry)
    const value = assignmentCacheValueToString(entry)
    this.mirror.set(key, value)
    this.persist()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  has(_entry: AssignmentCacheEntry): boolean {
    throw new Error('This should never be called for IndexedDBAssignmentCache, use getEntries() instead.')
  }

  /** Read all persisted entries. Returns [] on any error — never throws. */
  async getEntries(): Promise<[string, string][]> {
    try {
      const db = await openDB()
      try {
        const entries = await new Promise<[string, string][] | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const store = tx.objectStore(STORE_NAME)
          const request = store.get(this.storageKey)
          request.onsuccess = () => resolve(request.result as [string, string][] | undefined)
          request.onerror = () => reject(request.error)
        })
        if (Array.isArray(entries)) {
          this.mirror.clear()
          for (const [k, v] of entries) {
            this.mirror.set(k, v)
          }
          return entries
        }
      } finally {
        db.close()
      }
    } catch {
      // Silently fail — persistence should never break the SDK
    }
    return []
  }

  /** Remove persisted entries. Never throws. */
  async clear(): Promise<void> {
    this.mirror.clear()
    try {
      const db = await openDB()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          store.delete(this.storageKey)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    } catch {
      // Silently fail
    }
  }

  /** Fire-and-forget write to IndexedDB. Resolves on tx.oncomplete; silently swallows errors. */
  private persist(): void {
    const entries = Array.from(this.mirror.entries())
    openDB()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.put(entries, this.storageKey)
        tx.oncomplete = () => db.close()
        tx.onerror = () => db.close()
        tx.onabort = () => db.close()
      })
      .catch(() => {
        // Silently fail
      })
  }
}
