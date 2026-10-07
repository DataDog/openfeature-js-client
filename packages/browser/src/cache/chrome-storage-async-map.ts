import type { AsyncMap } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'

/** Chrome storage-backed {@link AsyncMap}. */
export default class ChromeStorageAsyncMap<T> implements AsyncMap<string, T> {
  private readonly prefix: string
  private keys: Set<string> | undefined
  private pendingOperation = Promise.resolve()

  constructor(
    private readonly storage: chrome.storage.StorageArea,
    namespace: string
  ) {
    this.prefix = `${namespace}:`
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key)
    return !!value
  }

  async get(key: string): Promise<T | undefined> {
    const storageKey = this.prefix + key
    const subset = await this.storage.get<Record<string, T>>(storageKey)
    return subset?.[storageKey] ?? undefined
  }

  async entries(): Promise<{ [p: string]: T }> {
    return this.run(async () => {
      const entries = await this.readEntries()
      this.keys = new Set(Object.keys(entries))
      await this.trim()
      for (const key of Object.keys(entries)) {
        if (!this.keys.has(key)) delete entries[key]
      }
      return entries
    })
  }

  private async readEntries(): Promise<Record<string, T>> {
    const entries = await this.storage.get<Record<string, T>>(null)
    const scopedEntries: Record<string, T> = Object.create(null)
    for (const [key, value] of Object.entries(entries)) {
      if (key.startsWith(this.prefix)) scopedEntries[key.slice(this.prefix.length)] = value
    }
    return scopedEntries
  }

  async set(key: string, value: T) {
    return this.run(async () => {
      this.keys ??= new Set(Object.keys(await this.readEntries()))
      this.keys.delete(key)
      this.keys.add(key)
      // Evict before writing so a full store has space for the new entry.
      await this.trim()
      await this.storage.set({ [this.prefix + key]: value })
    })
  }

  async clear() {
    return this.run(async () => {
      const keys = Object.keys(await this.readEntries()).map((key) => this.prefix + key)
      if (keys.length) await this.storage.remove(keys)
      this.keys = new Set()
    })
  }

  private async trim(): Promise<void> {
    const keys = this.keys!
    const removed: string[] = []
    for (const key of keys) {
      if (keys.size - removed.length <= MAX_EXPOSURE_CACHE_ENTRIES) break
      removed.push(key)
    }
    if (removed.length) {
      await this.storage.remove(removed.map((key) => this.prefix + key))
      for (const key of removed) keys.delete(key)
    }
  }

  private run<R>(operation: () => Promise<R>): Promise<R> {
    // Serialize writes and eviction. A failed operation must not stop later writes.
    const result = this.pendingOperation.then(operation)
    this.pendingOperation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
