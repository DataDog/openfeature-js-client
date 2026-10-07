import { assignmentCacheKeyToString, assignmentCacheValueToString, type ExposureEvent } from '@datadog/flagging-core'
import ChromeStorageAsyncMap from '../../src/cache/chrome-storage-async-map'
import { MAX_EXPOSURE_CACHE_ENTRIES } from '../../src/cache/constants'
import { LocalStorageAssignmentShim } from '../../src/cache/local-storage-assignment-shim'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'

const exposure = (id: string): ExposureEvent => ({
  subject: { id, attributes: {} },
  flag: { key: 'flag' },
  allocation: { key: 'allocation' },
  variant: { key: 'control' },
})
const entries = (count = MAX_EXPOSURE_CACHE_ENTRIES): [string, string][] =>
  Array.from({ length: count }, (_, index) => [`key-${index}`, 'value'])

describe('exposure cache capacity', () => {
  beforeEach(() => localStorage.clear())

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

  it('bounds localStorage on load and on write without changing another namespace', () => {
    localStorage.setItem('datadog-assignment-bounded', JSON.stringify(entries(MAX_EXPOSURE_CACHE_ENTRIES + 1)))
    localStorage.setItem('datadog-assignment-other', 'preserve')
    const cache = new LocalStorageAssignmentShim('bounded')
    expect(cache.has('key-0')).toBe(false)
    cache.set('key-1', 'updated')
    cache.set('new', 'value')
    const stored = new Map(JSON.parse(localStorage.getItem('datadog-assignment-bounded')!))
    expect(stored.size).toBe(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(stored.has('key-2')).toBe(false)
    expect(stored.get('key-1')).toBe('updated')
    expect(new LocalStorageAssignmentShim('bounded').has('new')).toBe(true)
    expect(localStorage.getItem('datadog-assignment-other')).toBe('preserve')
  })

  function chromeCache(count: number) {
    const stored: Record<string, string> = Object.fromEntries(
      entries(count).map(([key, value]) => [`bounded:${key}`, value])
    )
    stored['other:preserve'] = 'value'
    const storage = {
      get: jest.fn(async () => ({ ...stored })),
      set: jest.fn(async (items: Record<string, string>) => {
        Object.assign(stored, items)
      }),
      remove: jest.fn(async (keys: string[]) => {
        for (const key of keys) delete stored[key]
      }),
    }
    const cache = new ChromeStorageAsyncMap<string>(storage as unknown as chrome.storage.StorageArea, 'bounded')
    return { stored, storage, cache }
  }

  it('bounds Chrome storage on load and serializes concurrent writes and eviction', async () => {
    const { stored, cache } = chromeCache(MAX_EXPOSURE_CACHE_ENTRIES + 1)
    expect(Object.keys(await cache.entries())).toHaveLength(MAX_EXPOSURE_CACHE_ENTRIES)
    expect(stored['bounded:key-0']).toBeUndefined()
    await Promise.all([cache.set('key-1', 'updated'), cache.set('new-1', 'value'), cache.set('new-2', 'value')])
    expect(Object.keys(stored)).toHaveLength(MAX_EXPOSURE_CACHE_ENTRIES + 1)
    expect(stored['bounded:key-1']).toBe('updated')
    expect(stored['bounded:key-2']).toBeUndefined()
    expect(stored['bounded:key-3']).toBeUndefined()
    expect(stored['bounded:new-1']).toBe('value')
    expect(stored['bounded:new-2']).toBe('value')
    expect(stored['other:preserve']).toBe('value')
  })

  it('continues after a failed Chrome write and clears after queued writes', async () => {
    const { stored, storage, cache } = chromeCache(0)
    storage.set.mockRejectedValueOnce(new Error('quota'))
    await expect(cache.set('failed', 'value')).rejects.toThrow('quota')
    await cache.set('next', 'value')
    expect(stored['bounded:next']).toBe('value')
    const pendingWrite = cache.set('pending', 'value')
    await cache.clear()
    await pendingWrite
    expect(stored).toEqual({ 'other:preserve': 'value' })
  })
})
