import type { AsyncMap } from '@datadog/flagging-core'

/** Chrome storage-backed {@link AsyncMap}. */
export default class ChromeStorageAsyncMap<T> implements AsyncMap<string, T> {
  private readonly prefix: string

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
    const entries = await this.storage.get<Record<string, T>>(null)
    const scopedEntries: Record<string, T> = Object.create(null)
    for (const [key, value] of Object.entries(entries)) {
      if (key.startsWith(this.prefix)) scopedEntries[key.slice(this.prefix.length)] = value
    }
    return scopedEntries
  }

  async set(key: string, value: T) {
    await this.storage.set({ [this.prefix + key]: value })
  }

  async clear() {
    const keys = Object.keys(await this.entries()).map((key) => this.prefix + key)
    if (keys.length) await this.storage.remove(keys)
  }
}
