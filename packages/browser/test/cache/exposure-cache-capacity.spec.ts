import { assignmentCacheKeyToString, assignmentCacheValueToString, type ExposureEvent } from '@datadog/flagging-core'
import { MAX_EXPOSURE_CACHE_ENTRIES } from '../../src/cache/constants'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'
import { withStore } from '../../src/cache/indexeddb-store'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'
import { nextWrite } from './indexeddb-test-helpers'

const exposure = (id: string): ExposureEvent => ({
  subject: { id, attributes: {} },
  flag: { key: 'flag' },
  allocation: { key: 'allocation' },
  variant: { key: 'control' },
})
const entries = (count = MAX_EXPOSURE_CACHE_ENTRIES): [string, string][] =>
  Array.from({ length: count }, (_, index) => [`key-${index}`, 'value'])

describe('exposure cache capacity', () => {
  it('uses the Node provider limit and evicts the least recently used memory entry', async () => {
    expect(MAX_EXPOSURE_CACHE_ENTRIES).toBe(50_000)
    const cache = new SimpleAssignmentCache()
    const hot = exposure('hot')
    cache.set(hot)
    cache.setEntries(entries(MAX_EXPOSURE_CACHE_ENTRIES - 1))
    expect(cache.has(hot)).toBe(true)
    cache.set(exposure('new'))
    const stored = new Map(await cache.getEntries())
    expect(stored.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(stored.has('key-0')).toBe(false)
    expect(cache.has(hot)).toBe(true)
    expect(cache.has(exposure('new'))).toBe(true)
  })

  it('bounds imported memory entries and permits a new exposure after eviction', () => {
    const cache = new SimpleAssignmentCache()
    const old = exposure('old')
    cache.setEntries([[assignmentCacheKeyToString(old), assignmentCacheValueToString(old)], ...entries()])
    expect(cache.has(old)).toBe(false)
    cache.set(old)
    expect(cache.has(old)).toBe(true)
  })

  it('bounds IndexedDB on load and subsequent writes', async () => {
    await withStore('readwrite', (store) => store.put(entries(MAX_EXPOSURE_CACHE_ENTRIES + 1), 'assignments-scope'))
    const cache = new IndexedDBAssignmentCache('scope')
    const pruned = nextWrite()
    await cache.init()
    await pruned
    const imported = new Map(await cache.getEntries())
    expect(imported.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(imported.has('key-0')).toBe(false)
    const written = nextWrite()
    cache.set(exposure('new'))
    await written
    const stored = new Map((await withStore('readonly', (store) => store.get('assignments-scope'))).entries)
    expect(stored.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(stored.has('key-1')).toBe(false)
    expect(cache.has(exposure('new'))).toBe(true)
  })

  it("bounds the merged store without discarding another instance's recent writes", async () => {
    await withStore('readwrite', (store) => store.put(entries(), 'assignments-scope'))
    const first = new IndexedDBAssignmentCache('scope')
    const second = new IndexedDBAssignmentCache('scope')
    await Promise.all([first.init(), second.init()])
    const written = nextWrite(2)
    first.set(exposure('first'))
    second.set(exposure('second'))
    await written

    const stored = new Map((await withStore('readonly', (store) => store.get('assignments-scope'))).entries)
    expect(stored.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(stored.has('key-0')).toBe(false)
    expect(stored.has('key-1')).toBe(false)
    expect(stored.get(assignmentCacheKeyToString(exposure('first')))).toBe(
      assignmentCacheValueToString(exposure('first'))
    )
    expect(stored.get(assignmentCacheKeyToString(exposure('second')))).toBe(
      assignmentCacheValueToString(exposure('second'))
    )
  })
})
