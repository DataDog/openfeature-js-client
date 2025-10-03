import type { ExposureEvent } from '../configuration'
import { getMD5Hash } from '../obfuscation'

export type AssignmentCacheKey = Pick<ExposureEvent, 'flag' | 'subject'>
export type AssignmentCacheEntry = ExposureEvent

/** Converts an {@link AssignmentCacheKey} to a string. */
export function assignmentCacheKeyToString(exposureEvent: AssignmentCacheKey | ExposureEvent): string {
  const key: AssignmentCacheKey = {
    flag: {
      key: exposureEvent.flag.key,
    },
    subject: {
      id: exposureEvent.subject.id,
      attributes: exposureEvent.subject.attributes,
    },
  }
  return getMD5Hash(JSON.stringify(key))
}

/** Converts an {@link AssignmentCacheValue} to a string. */
export function assignmentCacheValueToString(cacheValue: AssignmentCacheEntry): string {
  return getMD5Hash(JSON.stringify(cacheValue))
}

export interface AsyncMap<K, V> {
  get(key: K): Promise<V | undefined>

  set(key: K, value: V): Promise<void>

  has(key: K): Promise<boolean>
}

export interface AssignmentCache {
  init(): Promise<void>

  set(key: AssignmentCacheEntry): void

  has(key: AssignmentCacheEntry): boolean
}

export abstract class AbstractAssignmentCache<T extends Map<string, string>> implements AssignmentCache {
  // key -> variation value hash
  protected constructor(protected readonly delegate: T) {}

  init(): Promise<void> {
    return Promise.resolve()
  }

  /** Returns whether the provided {@link AssignmentCacheEntry} is present in the cache. */
  has(entry: AssignmentCacheEntry): boolean {
    return this.get(entry) === assignmentCacheValueToString(entry)
  }

  get(key: AssignmentCacheKey): string | undefined {
    return this.delegate.get(assignmentCacheKeyToString(key))
  }

  /**
   * Stores the provided {@link AssignmentCacheEntry} in the cache. If the key already exists, it
   * will be overwritten.
   */
  set(entry: AssignmentCacheEntry): void {
    this.delegate.set(assignmentCacheKeyToString(entry), assignmentCacheValueToString(entry))
  }

  /**
   * Returns an array with all {@link AssignmentCacheEntry} entries in the cache as an array of
   * {@link string}s.
   */
  entries(): IterableIterator<[string, string]> {
    return this.delegate.entries()
  }
}
