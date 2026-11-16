import { assignmentCacheKeyToString, type ExposureEvent } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from '../../src/cache/constants'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'
import { createDebugLogger } from '../../src/debug'

class InspectableAssignmentCache extends SimpleAssignmentCache {
  get cacheDelegate() {
    return this.delegate
  }
}

const exposure = (index: number): ExposureEvent => ({
  flag: { key: 'flag' },
  subject: { id: String(index), attributes: {} },
  allocation: { key: 'allocation' },
  variant: { key: 'on' },
})

describe('bounded exposure-cache diagnostics', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([false, true])('inspects at most one cache entry per write with debug=%s', (enabled) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new InspectableAssignmentCache(createDebugLogger(enabled))
    cache.setEntries(Array.from({ length: MAX_EXPOSURE_CACHE_ENTRIES }, (_, index) => ['seed-' + index, 'value']))
    let visited = 0
    const entries = cache.cacheDelegate.entries.bind(cache.cacheDelegate)
    jest.spyOn(cache.cacheDelegate, 'entries').mockImplementation(function* () {
      for (const entry of entries()) {
        visited++
        yield entry
      }
    })
    for (let index = 0; index < 100; index++) cache.set(exposure(index))
    expect(visited).toBe(enabled ? 100 : 0)
    expect(cache.has(exposure(99))).toBe(true)
    if (enabled) {
      const records = log.mock.calls
        .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
        .filter((event) => event.event === 'exposure.cache_recorded')
      expect(records).toHaveLength(100)
      records.forEach((record, index) => {
        expect(record.details.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
        expect(record.details.evicted).toEqual([['seed-' + index, 'value']])
      })
    } else expect(log).not.toHaveBeenCalled()
  })

  it('reports no eviction on insertion below capacity or replacement, and honors LRU access order', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const cache = new InspectableAssignmentCache(createDebugLogger(true))
    cache.set(exposure(0))
    cache.set(exposure(0))
    let records = log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((event) => event.event === 'exposure.cache_recorded')
    expect(records.map((record) => ({ size: record.details.size, evicted: record.details.evicted }))).toEqual([
      { size: 1, evicted: [] },
      { size: 1, evicted: [] },
    ])
    cache.setEntries(Array.from({ length: MAX_EXPOSURE_CACHE_ENTRIES - 1 }, (_, index) => ['seed-' + index, 'value']))
    cache.has(exposure(0)) // Refresh the oldest real entry before inserting at capacity.
    cache.set(exposure(1))
    records = log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((event) => event.event === 'exposure.cache_recorded')
    expect(records.slice(-1)[0].details.evicted).toEqual([['seed-0', 'value']])
    expect(cache.get(exposure(0))).toBeDefined()
    expect(Array.from(cache.entries()).map(([key]) => key)).toContain(assignmentCacheKeyToString(exposure(1)))
  })
})
