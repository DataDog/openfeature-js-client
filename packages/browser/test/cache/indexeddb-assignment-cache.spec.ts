import { assignmentCacheKeyToString, assignmentCacheValueToString, type ExposureEvent } from '@datadog/flagging-core'
import { IDBDatabase, IDBObjectStore } from 'fake-indexeddb'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'
import * as storage from '../../src/cache/indexeddb-store'
import { deferred, nextWrite } from './indexeddb-test-helpers'

const exposure = (id: string): ExposureEvent => ({
  subject: { id, attributes: {} },
  flag: { key: 'flag' },
  allocation: { key: 'allocation' },
  variant: { key: 'control' },
})
const a = exposure('a')
const b = exposure('b')
const serialized = (entry: ExposureEvent): [string, string] => [
  assignmentCacheKeyToString(entry),
  assignmentCacheValueToString(entry),
]
const read = () => storage.withStore('readonly', (store) => store.get('assignments-scope'))
const seed = (value: unknown) => storage.withStore('readwrite', (store) => store.put(value, 'assignments-scope'))

describe('IndexedDBAssignmentCache', () => {
  let cache: IndexedDBAssignmentCache
  beforeEach(() => {
    cache = new IndexedDBAssignmentCache('scope')
  })
  afterEach(() => jest.restoreAllMocks())

  it('serves synchronously, batches writes, and restores on reload', async () => {
    await cache.init()
    const operations = jest.spyOn(storage, 'withStore')
    const written = nextWrite()
    cache.set(a)
    cache.set(b)
    expect(cache.has(a)).toBe(true)
    expect(cache.has(b)).toBe(true)
    await written
    expect(operations.mock.calls.filter(([mode]) => mode === 'readwrite')).toHaveLength(1)
    const reloaded = new IndexedDBAssignmentCache('scope')
    await reloaded.init()
    expect(reloaded.has(a)).toBe(true)
    expect(reloaded.has(b)).toBe(true)
  })

  it('preserves committed entries from another instance of the same scope', async () => {
    const other = new IndexedDBAssignmentCache('scope')
    await Promise.all([cache.init(), other.init()])
    let written = nextWrite()
    cache.set(a)
    await written
    written = nextWrite()
    other.set(b)
    await written

    const reloaded = new IndexedDBAssignmentCache('scope')
    await reloaded.init()
    expect(reloaded.has(a)).toBe(true)
    expect(reloaded.has(b)).toBe(true)
  })

  it('merges concurrent writes from separate instances atomically', async () => {
    const other = new IndexedDBAssignmentCache('scope')
    await Promise.all([cache.init(), other.init()])
    const written = nextWrite(2)
    cache.set(a)
    other.set(b)
    await written
    expect(new Map(await read())).toEqual(new Map([serialized(a), serialized(b)]))
  })

  it("does not restore cleared entries from another instance's loaded snapshot", async () => {
    await seed([serialized(a)])
    const other = new IndexedDBAssignmentCache('scope')
    await Promise.all([cache.init(), other.init()])
    await cache.clear()
    const written = nextWrite()
    other.set(b)
    await written

    const reloaded = new IndexedDBAssignmentCache('scope')
    await reloaded.init()
    expect(reloaded.has(a)).toBe(false)
    expect(reloaded.has(b)).toBe(true)
  })

  it("does not overwrite another instance's updated assignment with a loaded value", async () => {
    await seed([serialized(a)])
    const other = new IndexedDBAssignmentCache('scope')
    await Promise.all([cache.init(), other.init()])
    const updated = { ...a, variant: { key: 'treatment' } }
    let written = nextWrite()
    cache.set(updated)
    await written
    written = nextWrite()
    other.set(b)
    await written
    expect(await read()).toEqual([serialized(updated), serialized(b)])
  })

  it('initializes once without replacing an updated assignment with persisted data', async () => {
    const loading = deferred<unknown>()
    const started = deferred<void>()
    jest.spyOn(storage, 'withStore').mockImplementationOnce(() => {
      started.resolve()
      return loading.promise as Promise<never>
    })
    const initialized = cache.init()
    expect(cache.init()).toBe(initialized)
    await started.promise
    const updated = { ...a, variant: { key: 'treatment' } }
    const written = nextWrite()
    cache.set(updated)
    cache.set(b)
    loading.resolve([serialized(a)])
    await initialized
    await written
    expect(cache.has(a)).toBe(false)
    expect(cache.has(updated)).toBe(true)
    expect(cache.has(b)).toBe(true)
    expect(await read()).toEqual([serialized(updated), serialized(b)])
  })

  it('loads old entries before persisting a write made before init', async () => {
    await seed([serialized(a)])
    const written = nextWrite()
    cache.set(b)
    await written
    expect(cache.has(a)).toBe(true)
    expect(await read()).toEqual([serialized(a), serialized(b)])
  })

  it('does not restore entries when cleared during loading', async () => {
    const loading = deferred<unknown>()
    const started = deferred<void>()
    jest.spyOn(storage, 'withStore').mockImplementationOnce(() => {
      started.resolve()
      return loading.promise as Promise<never>
    })
    const initialized = cache.init()
    await started.promise
    const cleared = cache.clear()
    loading.resolve([serialized(a)])
    await Promise.all([initialized, cleared])
    expect(cache.has(a)).toBe(false)
    expect(await read()).toBeUndefined()
  })

  it('clears after an in-flight write and persists subsequent writes', async () => {
    await cache.init()
    const writing = deferred<void>()
    const started = deferred<void>()
    const transact = storage.withStore
    jest.spyOn(storage, 'withStore').mockImplementationOnce(async (mode, operation) => {
      started.resolve()
      await writing.promise
      return transact(mode, operation)
    })
    cache.set(a)
    await started.promise
    const cleared = cache.clear()
    expect(cache.has(a)).toBe(false)
    writing.resolve()
    await cleared
    expect(await read()).toBeUndefined()
    const written = nextWrite()
    cache.set(b)
    await written
    expect(await read()).toEqual([serialized(b)])
  })

  it('keeps a write made immediately after clear', async () => {
    await cache.init()
    const written = nextWrite()
    cache.set(a)
    const cleared = cache.clear()
    cache.set(b)
    await cleared
    await written
    expect(cache.has(a)).toBe(false)
    expect(await read()).toEqual([serialized(b)])
  })

  it('persists post-clear entries when a pre-clear write is waiting for initialization', async () => {
    const loading = deferred<unknown>()
    jest.spyOn(storage, 'withStore').mockImplementationOnce(() => loading.promise as Promise<never>)
    const initialized = cache.init()
    cache.set(a)
    // Let persistence queue behind the pending read, before clear queues its delete.
    await Promise.resolve()
    const cleared = cache.clear()
    cache.set(b)
    loading.resolve([])
    await Promise.all([initialized, cleared])
    const reloaded = new IndexedDBAssignmentCache('scope')
    await reloaded.init()
    expect(reloaded.has(a)).toBe(false)
    expect(reloaded.has(b)).toBe(true)
  })

  it('keeps memory usable after open failure and retries later writes', async () => {
    const open = jest.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('unavailable')
    })
    await cache.init()
    cache.set(a)
    await cache.clear()
    open.mockRestore()
    const written = nextWrite()
    cache.set(b)
    expect(cache.has(b)).toBe(true)
    await written
    expect(await read()).toEqual([serialized(b)])
  })

  it('does not let an aborted transaction poison later operations', async () => {
    await cache.init()
    const transaction = IDBDatabase.prototype.transaction
    const aborted = deferred<void>()
    jest.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args)
      tx.addEventListener('abort', () => aborted.resolve())
      tx.abort()
      return tx
    })
    cache.set(a)
    await aborted.promise
    expect(cache.has(a)).toBe(true)
    const written = nextWrite()
    cache.set(b)
    await written
    expect(await read()).toEqual([serialized(a), serialized(b)])
  })

  it('retries the latest assignment after a failed write without replaying loaded entries', async () => {
    await seed([serialized(b)])
    await cache.init()
    const attempted = deferred<void>()
    jest.spyOn(storage, 'withStore').mockImplementationOnce(async () => {
      attempted.resolve()
      throw new Error('write failed')
    })
    cache.set(a)
    await attempted.promise
    const other = new IndexedDBAssignmentCache('scope')
    await other.clear()
    const updated = { ...a, variant: { key: 'treatment' } }
    const written = nextWrite()
    cache.set(updated)
    await written
    expect(await read()).toEqual([serialized(updated)])
  })

  it('aborts and retries when put throws inside the merge callback', async () => {
    await cache.init()
    const aborted = deferred<void>()
    const put = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore) {
      this.transaction.addEventListener('abort', () => aborted.resolve())
      throw new Error('quota')
    })
    cache.set(a)
    await aborted.promise
    put.mockRestore()
    expect(cache.has(a)).toBe(true)
    const written = nextWrite()
    cache.set(b)
    await written
    expect(await read()).toEqual([serialized(a), serialized(b)])
  })

  it('settles a read transaction that aborts after its request succeeds', async () => {
    const get = IDBObjectStore.prototype.get
    jest.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(function (this: IDBObjectStore, key) {
      const request = get.call(this, key)
      request.addEventListener('success', () => request.transaction!.abort())
      return request
    })
    await expect(cache.init()).resolves.toBeUndefined()
    expect(cache.has(a)).toBe(false)
    const written = nextWrite()
    cache.set(a)
    await written
    expect(await read()).toEqual([serialized(a)])
  })

  it('closes the connection when a storage operation throws', async () => {
    const close = jest.spyOn(IDBDatabase.prototype, 'close')
    await expect(
      storage.withStore('readwrite', () => {
        throw new Error('quota')
      })
    ).rejects.toThrow('quota')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it.each([null, 'invalid', { invalid: true }, [null, [], ['key', 12], ['', 'value']]])(
    'ignores malformed persisted data: %j',
    async (value) => {
      await seed(value)
      await expect(cache.init()).resolves.toBeUndefined()
      expect(await cache.getEntries()).toEqual([])
    }
  )
})
