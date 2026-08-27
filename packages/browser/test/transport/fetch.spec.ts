import { withRetry, withTimeout } from '../../src/transport/fetch'

function createPendingFetch() {
  return jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
}

describe('withTimeout', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('aborts the request when the timeout expires', async () => {
    jest.useFakeTimers()
    const fetchImplementation = createPendingFetch()
    const request = withTimeout(fetchImplementation, 100)('/flags')
    const expectation = expect(request).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'The request timed out after 100 ms',
    })

    await jest.advanceTimersByTimeAsync(100)

    await expectation
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('preserves caller cancellation', async () => {
    const fetchImplementation = createPendingFetch()
    const controller = new AbortController()
    const reason = new DOMException('Configuration request superseded', 'AbortError')
    const request = withTimeout(fetchImplementation, 100)('/flags', { signal: controller.signal })

    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('clears the timeout after the request succeeds', async () => {
    jest.useFakeTimers()
    const response = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withTimeout(fetchImplementation, 100)('/flags')).resolves.toBe(response)

    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects an invalid timeout of %s', (timeoutMs) => {
    expect(() => withTimeout(globalThis.fetch, timeoutMs)).toThrow(
      new RangeError('timeoutMs must be a non-negative integer')
    )
  })
})

describe('withRetry', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('retries network failures up to the configured count', async () => {
    const response = new Response(null, { status: 200 })
    const fetchImplementation = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Network error'))
      .mockResolvedValueOnce(response)

    await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(response)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it.each([408, 500, 599])('retries an HTTP %s response', async (status) => {
    const cancel = jest.fn().mockResolvedValue(undefined)
    const retryableResponse = { status, body: { cancel } } as unknown as Response
    const successfulResponse = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValueOnce(retryableResponse).mockResolvedValue(successfulResponse)

    await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(successfulResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('returns a non-retryable response without retrying', async () => {
    const response = new Response(null, { status: 400 })
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withRetry(fetchImplementation, 2)('/flags')).resolves.toBe(response)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry an HTTP 429 response without a Retry-After policy', async () => {
    const response = new Response(null, { status: 429 })
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withRetry(fetchImplementation, 2)('/flags')).resolves.toBe(response)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry caller cancellation', async () => {
    const fetchImplementation = createPendingFetch()
    const controller = new AbortController()
    const reason = new DOMException('Configuration request superseded', 'AbortError')
    const request = withRetry(fetchImplementation, 2)('/flags', { signal: controller.signal })

    controller.abort(reason)

    await expect(request).rejects.toBe(reason)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('applies a composed timeout to each attempt', async () => {
    jest.useFakeTimers()
    const successfulResponse = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchImplementation.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return Promise.resolve(successfulResponse)
    })

    const request = withRetry(withTimeout(fetchImplementation, 100), 1)('/flags')
    await jest.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toBe(successfulResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects an invalid retry count of %s', (retries) => {
    expect(() => withRetry(globalThis.fetch, retries)).toThrow(new RangeError('retries must be a non-negative integer'))
  })
})
