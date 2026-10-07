import { IDBObjectStore } from 'fake-indexeddb'

/** Observe an actual commit instead of sleeping for an assumed write duration. */
export function nextWrite(): Promise<void> {
  const put = IDBObjectStore.prototype.put
  return new Promise((resolve, reject) => {
    const spy = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = put.apply(this, args)
      if (!String(args[1]).startsWith('assignments-')) return request
      spy.mockRestore()
      request.transaction!.addEventListener('complete', () => resolve())
      request.transaction!.addEventListener('abort', () => reject(request.transaction!.error))
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
