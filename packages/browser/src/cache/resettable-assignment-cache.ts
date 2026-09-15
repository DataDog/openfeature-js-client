import {
  type AssignmentCache,
  type AssignmentCacheEntry,
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
} from '@datadog/flagging-core'

/**
 * Serializes asynchronous cache lifecycle operations while making a clear visible synchronously.
 * Entries written after a clear request are replayed after pending initialization and clearing finish.
 */
export class ResettableAssignmentCache implements AssignmentCache {
  private lifecycle: Promise<void> = Promise.resolve()
  private entriesAfterClear?: Map<string, AssignmentCacheEntry>

  constructor(private readonly delegate: AssignmentCache) {}

  init(): Promise<void> {
    const operation = this.afterLifecycle(() => this.delegate.init())
    this.lifecycle = operation
    return operation
  }

  clear(): Promise<void> {
    const entriesAfterClear = new Map<string, AssignmentCacheEntry>()
    this.entriesAfterClear = entriesAfterClear

    const operation = this.afterLifecycle(async () => {
      await this.delegate.clear()
      if (this.entriesAfterClear !== entriesAfterClear) {
        return
      }

      entriesAfterClear.forEach((entry) => {
        this.delegate.set(entry)
      })
      this.entriesAfterClear = undefined
    })
    this.lifecycle = operation
    return operation
  }

  set(entry: AssignmentCacheEntry): void {
    this.entriesAfterClear?.set(assignmentCacheKeyToString(entry), entry)
    this.delegate.set(entry)
  }

  has(entry: AssignmentCacheEntry): boolean {
    if (!this.entriesAfterClear) {
      return this.delegate.has(entry)
    }

    const cached = this.entriesAfterClear.get(assignmentCacheKeyToString(entry))
    return cached !== undefined && assignmentCacheValueToString(cached) === assignmentCacheValueToString(entry)
  }

  private afterLifecycle(operation: () => Promise<void> | void): Promise<void> {
    return this.lifecycle.catch(() => {}).then(operation)
  }
}
