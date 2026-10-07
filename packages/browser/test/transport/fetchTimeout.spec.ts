/** @jest-environment node */

import { withTimeout } from '../../src/transport/fetch'
import { createPendingFetch } from './fetchTestUtils'

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

  describe('abort behavior', () => {
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

    it('preserves a caller signal that was aborted before the wrapper runs', async () => {
      const fetchImplementation = createPendingFetch()
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      controller.abort(reason)

      await expect(withTimeout(fetchImplementation, 100)('/flags', { signal: controller.signal })).rejects.toBe(reason)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('treats a null init signal as overriding the input Request signal', async () => {
      const controller = new AbortController()
      controller.abort(new DOMException('Request signal should be ignored', 'AbortError'))
      const input = new Request('https://example.test/flags', { signal: controller.signal })
      const response = new Response(null, { status: 200 })
      const fetchImplementation = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return init?.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(response)
      })

      await expect(withTimeout(fetchImplementation, 100)(input, { signal: null })).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('inherits the input Request signal when the init signal is undefined', async () => {
      const fetchImplementation = createPendingFetch()
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      const input = new Request('https://example.test/flags', { signal: controller.signal })
      const request = withTimeout(fetchImplementation, 100)(input, { signal: undefined })

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

    it('preserves a fetch rejection when no timeout or caller cancellation occurred', async () => {
      const error = new TypeError('Invalid request')
      const fetchImplementation = jest.fn().mockRejectedValue(error)

      await expect(withTimeout(fetchImplementation, 100)('/flags')).rejects.toBe(error)
    })
  })

  describe('response lifecycle', () => {
    it('clears the timeout after the request succeeds', async () => {
      jest.useFakeTimers()
      const response = new Response(null, { status: 200 })
      const fetchImplementation = jest.fn().mockResolvedValue(response)

      await expect(withTimeout(fetchImplementation, 100)('/flags')).resolves.toBe(response)

      expect(jest.getTimerCount()).toBe(0)
    })

    it('returns a readable buffered response', async () => {
      const originalResponse = new Response('configuration', {
        headers: { 'content-type': 'text/plain' },
        status: 201,
        statusText: 'Created',
      })
      const fetchImplementation = jest.fn().mockResolvedValue(originalResponse)

      const response = await withTimeout(fetchImplementation, 100)('/flags')

      expect(response).toBe(originalResponse)
      expect(response.status).toBe(201)
      expect(response.statusText).toBe('Created')
      expect(response.headers.get('content-type')).toBe('text/plain')
      await expect(response.text()).resolves.toBe('configuration')
    })

    it('preserves native response metadata when the buffered response is cloned', async () => {
      const nativeResponse = await globalThis.fetch('data:text/plain,configuration')
      const fetchImplementation = jest.fn().mockResolvedValue(nativeResponse)

      const response = await withTimeout(fetchImplementation, 100)('/flags')
      const clonedResponse = response.clone()

      expect(response.url).toBe(nativeResponse.url)
      expect(response.type).toBe(nativeResponse.type)
      expect(clonedResponse.url).toBe(nativeResponse.url)
      expect(clonedResponse.type).toBe(nativeResponse.type)
      await expect(clonedResponse.text()).resolves.toBe('configuration')
    })

    it('treats zero as no timeout', async () => {
      jest.useFakeTimers()
      const fetchImplementation = createPendingFetch()
      const controller = new AbortController()
      const reason = new DOMException('Test cleanup', 'AbortError')
      let settled = false
      const request = withTimeout(fetchImplementation, 0)('/flags', { signal: controller.signal })
      void request.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await jest.advanceTimersByTimeAsync(1_000)

      expect(settled).toBe(false)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
      controller.abort(reason)
      await expect(request).rejects.toBe(reason)
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  describe('input validation', () => {
    it.each([-1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])('rejects an invalid timeout of %s', (timeoutMs) => {
      expect(() => withTimeout(globalThis.fetch, timeoutMs)).toThrow(
        new RangeError('timeoutMs must be an integer between 0 and 2147483647')
      )
    })
  })
})
