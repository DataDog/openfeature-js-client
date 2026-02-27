import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { buildStorageKeySuffix, getMD5Hash } from '@datadog/flagging-core'

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

function buildConfigKey(clientToken: string, context: EvaluationContext): string {
  const tokenSuffix = buildStorageKeySuffix(clientToken)
  const contextHash = getMD5Hash(JSON.stringify(context)).slice(0, 16)
  return `flags-config-${tokenSuffix}-${contextHash}`
}

export class IndexedDBFlagsCache {
  private readonly clientToken: string

  constructor(clientToken: string) {
    this.clientToken = clientToken
  }

  /** Read cached config for the given context. Returns undefined on miss or any error. */
  async get(context: EvaluationContext): Promise<FlagsConfiguration | undefined> {
    try {
      const configKey = buildConfigKey(this.clientToken, context)
      const db = await openDB()
      try {
        const config = await new Promise<FlagsConfiguration | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const store = tx.objectStore(STORE_NAME)
          const request = store.get(configKey)
          request.onsuccess = () => resolve(request.result as FlagsConfiguration | undefined)
          request.onerror = () => reject(request.error)
        })
        if (!config || typeof config !== 'object') {
          return undefined
        }
        return config.precomputed ? config : undefined
      } finally {
        db.close()
      }
    } catch {
      return undefined
    }
  }

  /** Fire-and-forget persist. Never throws. */
  set(config: FlagsConfiguration, context: EvaluationContext): void {
    const configKey = buildConfigKey(this.clientToken, context)
    openDB()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.put(config, configKey)
        tx.oncomplete = () => db.close()
        tx.onerror = () => db.close()
        tx.onabort = () => db.close()
      })
      .catch(() => {
        // Silently fail — persistence should never break the SDK
      })
  }
}
