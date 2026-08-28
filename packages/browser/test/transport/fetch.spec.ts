/** @jest-environment node */

import { withRetry, withTimeout } from '../../src/transport/fetch'

function createPendingFetch() {
  return jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
}

function createHeadersThenPendingBodyFetch() {
  return jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    const body = new ReadableStream({
      start(controller) {
        const abort = () => controller.error(signal?.reason)
        if (signal?.aborted) {
          abort()
        } else {
          signal?.addEventListener('abort', abort, { once: true })
        }
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
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

  it('keeps the timeout active while the response body is pending', async () => {
    jest.useFakeTimers()
    const fetchImplementation = createHeadersThenPendingBodyFetch()
    const request = withTimeout(fetchImplementation, 100)('/flags')
    const expectation = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })

    await jest.advanceTimersByTimeAsync(100)

    await expectation
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('preserves the timeout reason when the browser converts the stream error', async () => {
    jest.useFakeTimers()
    const fetchImplementation = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new TypeError('Failed to fetch')), {
            once: true,
          })
        },
      })
      return Promise.resolve(new Response(body))
    })
    const request = withTimeout(fetchImplementation, 100)('/flags')
    const expectation = expect(request).rejects.toMatchObject({ name: 'TimeoutError' })

    await jest.advanceTimersByTimeAsync(100)

    await expectation
  })

  it('preserves caller cancellation while the response body is pending', async () => {
    const fetchImplementation = createHeadersThenPendingBodyFetch()
    const controller = new AbortController()
    const reason = new DOMException('Configuration request superseded', 'AbortError')
    const request = withTimeout(fetchImplementation, 100)('/flags', { signal: controller.signal })

    await Promise.resolve()
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

  it('returns a readable buffered response', async () => {
    const fetchImplementation = jest.fn().mockResolvedValue(
      new Response('configuration', {
        headers: { 'content-type': 'text/plain' },
        status: 201,
        statusText: 'Created',
      })
    )

    const response = await withTimeout(fetchImplementation, 100)('/flags')

    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('content-type')).toBe('text/plain')
    await expect(response.text()).resolves.toBe('configuration')
  })

  it('treats zero as no timeout', async () => {
    jest.useFakeTimers()
    const response = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withTimeout(fetchImplementation, 0)('/flags')).resolves.toBe(response)

    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([-1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])('rejects an invalid timeout of %s', (timeoutMs) => {
    expect(() => withTimeout(globalThis.fetch, timeoutMs)).toThrow(
      new RangeError('timeoutMs must be an integer between 0 and 2147483647')
    )
  })
})

describe('withRetry', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
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

  it('replays a Request body for each attempt', async () => {
    const requestBodies: string[] = []
    const fetchImplementation = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requestBodies.push(await request.text())
      return new Response(null, { status: requestBodies.length === 1 ? 500 : 200 })
    })
    const request = new Request('https://example.test/flags', {
      method: 'POST',
      body: 'configuration request',
    })

    await expect(withRetry(fetchImplementation, 1)(request)).resolves.toMatchObject({ status: 200 })
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(requestBodies).toEqual(['configuration request', 'configuration request'])
  })

  it.each([408, 500, 599])('retries an HTTP %s response', async (status) => {
    let cancelled = false
    const retryableResponse = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { status }
    )
    const successfulResponse = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValueOnce(retryableResponse).mockResolvedValue(successfulResponse)

    await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(successfulResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(cancelled).toBe(true)
    expect(retryableResponse.bodyUsed).toBe(true)
  })

  it('keeps the final retryable response body readable', async () => {
    const response = new Response(JSON.stringify({ errors: [{ detail: 'unavailable' }] }), {
      headers: { 'content-type': 'application/json' },
      status: 503,
    })
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withRetry(fetchImplementation, 0)('/flags')).resolves.toBe(response)

    expect(response.bodyUsed).toBe(false)
    await expect(response.json()).resolves.toEqual({ errors: [{ detail: 'unavailable' }] })
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

  it('does not retry when cancellation races with response cleanup', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Configuration request superseded', 'AbortError')
    let finishCancel: (() => void) | undefined
    const retryableResponse = new Response(
      new ReadableStream({
        cancel() {
          return new Promise<void>((resolve) => {
            finishCancel = resolve
          })
        },
      }),
      { status: 500 }
    )
    const fetchImplementation = jest.fn().mockResolvedValue(retryableResponse)
    const request = withRetry(fetchImplementation, 1)('/flags', { signal: controller.signal })

    await Promise.resolve()
    expect(retryableResponse.bodyUsed).toBe(true)
    controller.abort(reason)
    finishCancel?.()

    await expect(request).resolves.toBe(retryableResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry response cleanup failures', async () => {
    const error = new Error('Stream cleanup failed')
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw error
        },
      }),
      { status: 500 }
    )
    const fetchImplementation = jest.fn().mockResolvedValue(response)

    await expect(withRetry(fetchImplementation, 1)('/flags')).rejects.toBe(error)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('does not retry non-Fetch errors', async () => {
    const error = new RangeError('Invalid request configuration')
    const fetchImplementation = jest.fn().mockRejectedValue(error)

    await expect(withRetry(fetchImplementation, 2)('/flags')).rejects.toBe(error)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After on HTTP 503 responses', async () => {
    jest.useFakeTimers()
    const retryableResponse = new Response(null, { headers: { 'retry-after': '1' }, status: 503 })
    const successfulResponse = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValueOnce(retryableResponse).mockResolvedValue(successfulResponse)
    const request = withRetry(fetchImplementation, 1)('/flags')

    await jest.advanceTimersByTimeAsync(999)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    await expect(request).resolves.toBe(successfulResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('uses randomized exponential backoff without Retry-After', async () => {
    jest.useFakeTimers()
    jest.mocked(Math.random).mockReturnValue(0.5)
    const retryableResponse = new Response(null, { status: 503 })
    const successfulResponse = new Response(null, { status: 200 })
    const fetchImplementation = jest.fn().mockResolvedValueOnce(retryableResponse).mockResolvedValue(successfulResponse)
    const request = withRetry(fetchImplementation, 1)('/flags')

    await jest.advanceTimersByTimeAsync(49)
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    await expect(request).resolves.toBe(successfulResponse)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('rejects a non-replayable RequestInit body stream', () => {
    const body = new ReadableStream()

    expect(() => withRetry(globalThis.fetch, 1)('/flags', { body } as RequestInit)).rejects.toThrow(
      'withRetry cannot replay a RequestInit body stream; pass a Request with a cloneable body'
    )
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

  it.each([-1, 1.5, 11, 2 ** 53 + 2, Number.POSITIVE_INFINITY])('rejects an invalid retry count of %s', (retries) => {
    expect(() => withRetry(globalThis.fetch, retries)).toThrow(
      new RangeError('retries must be an integer between 0 and 10')
    )
  })
})
