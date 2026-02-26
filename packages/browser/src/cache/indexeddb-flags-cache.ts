import type { FlagsConfiguration } from '@datadog/flagging-core'

const DB_NAME = 'dd-flagging'
const DB_VERSION = 1
const STORE_NAME = 'configurations'
const CONFIG_KEY = 'flags-config'

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

export class IndexedDBFlagsCache {
  async get(): Promise<FlagsConfiguration | undefined> {
    try {
      const db = await openDB()
      try {
        const value = await new Promise<string | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const store = tx.objectStore(STORE_NAME)
          const request = store.get(CONFIG_KEY)
          request.onsuccess = () => resolve(request.result as string | undefined)
          request.onerror = () => reject(request.error)
        })
        if (typeof value !== 'string') {
          return undefined
        }
        const config: FlagsConfiguration = JSON.parse(value)
        return config.precomputed ? config : undefined
      } finally {
        db.close()
      }
    } catch {
      return undefined
    }
  }

  async set(config: FlagsConfiguration): Promise<void> {
    try {
      const serialized = JSON.stringify(config)
      const db = await openDB()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          const request = store.put(serialized, CONFIG_KEY)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    } catch {
      // Silently fail — persistence should never break the SDK
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await openDB()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          const request = store.delete(CONFIG_KEY)
          request.onsuccess = () => resolve()
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    } catch {
      // Silently fail
    }
  }
}
