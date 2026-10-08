import { IDBObjectStore } from 'fake-indexeddb'

/** Observe an actual commit instead of sleeping for an assumed write duration. */
export function nextWrite(count = 1): Promise<void> {
  const put = IDBObjectStore.prototype.put
  return new Promise((resolve, reject) => {
    let started = 0
    let completed = 0
    const spy = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = put.apply(this, args)
      if (!String(args[1]).startsWith('assignments-')) return request
      if (++started === count) spy.mockRestore()
      request.transaction!.addEventListener('complete', () => {
        if (++completed === count) resolve()
      })
      request.transaction!.addEventListener('abort', () => {
        spy.mockRestore()
        reject(request.transaction!.error)
      })
      return request
    })
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
