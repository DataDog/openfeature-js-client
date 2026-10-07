// noinspection JSUnusedGlobalSymbols (methods are used by common repository)

import { MAX_EXPOSURE_CACHE_ENTRIES } from './constants'
import { hasWindowLocalStorage } from './helpers'

export class LocalStorageAssignmentShim {
  private readonly localStorageKey: string

  public constructor(storageKeySuffix: string) {
    if (!hasWindowLocalStorage()) {
      throw new Error('LocalStorage is not available')
    }
    const keySuffix = storageKeySuffix ? `-${storageKeySuffix}` : ''
    this.localStorageKey = `datadog-assignment${keySuffix}`
  }

  clear(): void {
    window.localStorage.removeItem(this.localStorageKey)
  }

  delete(key: string): boolean {
    return this.getCache().delete(key)
  }

  forEach(
    callbackfn: (value: string, key: string, map: Map<string, string>) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thisArg?: unknown
  ): void {
    this.getCache().forEach(callbackfn, thisArg)
  }

  entries(): IterableIterator<[string, string]> {
    return this.getCache().entries()
  }

  keys(): IterableIterator<string> {
    return this.getCache().keys()
  }

  values(): IterableIterator<string> {
    return this.getCache().values()
  }

  public has(key: string): boolean {
    return this.getCache().has(key)
  }

  public get(key: string): string | undefined {
    return this.getCache().get(key) ?? undefined
  }

  public set(key: string, value: string): this {
    const cache = this.getCache()
    cache.delete(key)
    cache.set(key, value)
    this.trim(cache)
    return this.setCache(cache)
  }

  private getCache(): Map<string, string> {
    const cache = window.localStorage.getItem(this.localStorageKey)
    const entries: Map<string, string> = cache ? new Map(JSON.parse(cache)) : new Map()
    if (entries.size > MAX_EXPOSURE_CACHE_ENTRIES) {
      this.trim(entries)
      this.setCache(entries)
    }
    return entries
  }

  private trim(cache: Map<string, string>): void {
    for (const key of cache.keys()) {
      if (cache.size <= MAX_EXPOSURE_CACHE_ENTRIES) break
      cache.delete(key)
    }
  }

  private setCache(cache: Map<string, string>): this {
    window.localStorage.setItem(this.localStorageKey, JSON.stringify(Array.from(cache.entries())))
    return this
  }
}
