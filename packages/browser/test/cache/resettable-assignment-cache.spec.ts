import {
  type AssignmentCache,
  type AssignmentCacheEntry,
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
} from '@datadog/flagging-core'
import { ResettableAssignmentCache } from '../../src/cache/resettable-assignment-cache'

const assignmentA = assignment('a')
const assignmentB = assignment('b')

describe('ResettableAssignmentCache', () => {
  it('only replays entries from the latest clear generation', async () => {
    const delegate = new DeferredClearCache()
    const cache = new ResettableAssignmentCache(delegate)

    const firstClear = cache.clear()
    await delegate.clearStarted()
    cache.set(assignmentA)

    const secondClear = cache.clear()
    cache.set(assignmentB)
    delegate.resolveClear()
    await delegate.clearStarted()
    delegate.resolveClear()
    await Promise.all([firstClear, secondClear])

    expect(cache.has(assignmentA)).toBe(false)
    expect(cache.has(assignmentB)).toBe(true)
    expect(delegate.has(assignmentA)).toBe(false)
    expect(delegate.has(assignmentB)).toBe(true)
  })

  it('recovers lifecycle sequencing after rejected initialization and clearing', async () => {
    const delegate = new InMemoryAssignmentCache()
    delegate.init = jest.fn().mockRejectedValueOnce(new Error('init failed'))
    delegate.clear = jest
      .fn()
      .mockRejectedValueOnce(new Error('clear failed'))
      .mockImplementationOnce(() => delegate.entries.clear())
    const cache = new ResettableAssignmentCache(delegate)

    await expect(cache.init()).rejects.toThrow('init failed')
    const failedClear = cache.clear()
    cache.set(assignmentA)
    await expect(failedClear).rejects.toThrow('clear failed')
    expect(cache.has(assignmentA)).toBe(true)

    const recoveredClear = cache.clear()
    cache.set(assignmentB)
    await expect(recoveredClear).resolves.toBeUndefined()

    expect(cache.has(assignmentA)).toBe(false)
    expect(cache.has(assignmentB)).toBe(true)
  })
})

class InMemoryAssignmentCache implements AssignmentCache {
  readonly entries = new Map<string, string>()

  init(): Promise<void> {
    return Promise.resolve()
  }

  clear(): Promise<void> | void {
    this.entries.clear()
  }

  set(entry: AssignmentCacheEntry): void {
    this.entries.set(assignmentCacheKeyToString(entry), assignmentCacheValueToString(entry))
  }

  has(entry: AssignmentCacheEntry): boolean {
    return this.entries.get(assignmentCacheKeyToString(entry)) === assignmentCacheValueToString(entry)
  }
}

class DeferredClearCache extends InMemoryAssignmentCache {
  private clearResolvers: Array<() => void> = []
  private clearStartedResolvers: Array<() => void> = []

  clear(): Promise<void> {
    this.clearStartedResolvers.shift()?.()
    return new Promise((resolve) => {
      this.clearResolvers.push(() => {
        this.entries.clear()
        resolve()
      })
    })
  }

  clearStarted(): Promise<void> {
    return new Promise((resolve) => this.clearStartedResolvers.push(resolve))
  }

  resolveClear(): void {
    this.clearResolvers.shift()?.()
  }
}

function assignment(id: string): AssignmentCacheEntry {
  return {
    allocation: { key: 'allocation' },
    flag: { key: 'flag' },
    variant: { key: id },
    subject: { id, attributes: {} },
  }
}
