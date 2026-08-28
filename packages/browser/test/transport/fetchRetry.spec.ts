/** @jest-environment node */

import { runInNewContext } from 'node:vm'

import { withRetry, withTimeout } from '../../src/transport/fetch'
import { createDeferred, createPendingFetch } from './fetchTestUtils'

function createResponseSequence(firstResponse: Response) {
  const successfulResponse = new Response(null, { status: 200 })
  const fetchImplementation = jest.fn().mockResolvedValueOnce(firstResponse).mockResolvedValue(successfulResponse)
  return { fetchImplementation, successfulResponse }
}

async function expectRetryAfterDelay(
  request: Promise<Response>,
  fetchImplementation: jest.Mock,
  successfulResponse: Response,
  delayMs: number
): Promise<void> {
  await jest.advanceTimersByTimeAsync(delayMs - 1)
  expect(fetchImplementation).toHaveBeenCalledTimes(1)
  await jest.advanceTimersByTimeAsync(1)

  await expect(request).resolves.toBe(successfulResponse)
  expect(fetchImplementation).toHaveBeenCalledTimes(2)
}

describe('withRetry', () => {
  beforeEach(() => {
    jest.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('error retry policy', () => {
    it('retries network failures up to the configured count', async () => {
      const response = new Response(null, { status: 200 })
      const fetchImplementation = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('Network error'))
        .mockResolvedValueOnce(response)

      await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    })

    it('stops after the configured number of retries', async () => {
      const error = new TypeError('Network error')
      const fetchImplementation = jest.fn().mockRejectedValue(error)

      await expect(withRetry(fetchImplementation, 2)('/flags')).rejects.toBe(error)
      expect(fetchImplementation).toHaveBeenCalledTimes(3)
    })

    it('retries a TypeError from another realm', async () => {
      const error = runInNewContext('new TypeError("Network error")') as TypeError
      const response = new Response(null, { status: 200 })
      const fetchImplementation = jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(response)

      expect(error).not.toBeInstanceOf(TypeError)
      await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['a named non-Fetch error', new RangeError('Invalid request configuration')],
      ['a primitive rejection', 'Invalid request configuration'],
    ])('does not retry %s', async (_description, error) => {
      const fetchImplementation = jest.fn().mockRejectedValue(error)

      await expect(withRetry(fetchImplementation, 2)('/flags')).rejects.toBe(error)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })
  })

  describe('request replay', () => {
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

    it('replays an overriding RequestInit body without cloning a consumed Request', async () => {
      const requestBodies: string[] = []
      const fetchImplementation = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requestBodies.push(await request.text())
        return new Response(null, { status: requestBodies.length === 1 ? 500 : 200 })
      })
      const request = new Request('https://example.test/flags', {
        method: 'POST',
        body: 'original request',
      })
      await request.text()

      await expect(withRetry(fetchImplementation, 1)(request, { body: 'replacement request' })).resolves.toMatchObject({
        status: 200,
      })
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
      expect(requestBodies).toEqual(['replacement request', 'replacement request'])
    })

    it('replays a Request-like body from another realm', async () => {
      type ForeignRequest = {
        clone: () => ForeignRequest
        readBody: () => string
        signal: AbortSignal
      }
      const signal = new AbortController().signal
      const createRequest = runInNewContext(
        `(() => {
        function createRequest() {
          let consumed = false
          return {
            clone: createRequest,
            readBody() {
              if (consumed) throw new TypeError('Body has already been consumed')
              consumed = true
              return 'configuration request'
            },
            signal,
          }
        }
        return createRequest
      })()`,
        { signal }
      ) as () => ForeignRequest
      const request = createRequest()
      const requestBodies: string[] = []
      const fetchImplementation = jest.fn(async (input: RequestInfo | URL) => {
        requestBodies.push((input as unknown as ForeignRequest).readBody())
        return new Response(null, { status: requestBodies.length === 1 ? 500 : 200 })
      })

      expect(request).not.toBeInstanceOf(Request)
      await expect(withRetry(fetchImplementation, 1)(request as unknown as Request)).resolves.toMatchObject({
        status: 200,
      })
      expect(requestBodies).toEqual(['configuration request', 'configuration request'])
    })
  })

  describe('effective request signal', () => {
    it('reads caller cancellation from a Request-like input from another realm', async () => {
      const controller = new AbortController()
      const request = {
        clone() {
          return this
        },
        signal: controller.signal,
      } as unknown as Request
      const response = new Response(null, { status: 500 })
      const fetchImplementation = jest.fn().mockResolvedValue(response)
      const result = withRetry(fetchImplementation, 1)(request)

      controller.abort(new DOMException('Configuration request superseded', 'AbortError'))

      await expect(result).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('treats a null init signal as overriding the input Request signal', async () => {
      const controller = new AbortController()
      controller.abort(new DOMException('Request signal should be ignored', 'AbortError'))
      const input = new Request('https://example.test/flags', { signal: controller.signal })
      const retryableResponse = new Response(null, { status: 500 })
      const successfulResponse = new Response(null, { status: 200 })
      const fetchImplementation = jest
        .fn()
        .mockResolvedValueOnce(retryableResponse)
        .mockResolvedValue(successfulResponse)

      await expect(withRetry(fetchImplementation, 1)(input, { signal: null })).resolves.toBe(successfulResponse)
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    })
  })

  describe('response retry policy', () => {
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
      const fetchImplementation = jest
        .fn()
        .mockResolvedValueOnce(retryableResponse)
        .mockResolvedValue(successfulResponse)

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

    it('keeps the final retryable response body readable after retries are exhausted', async () => {
      const firstResponse = new Response('first failure', { status: 503 })
      const finalResponse = new Response('final failure', { status: 503 })
      const fetchImplementation = jest.fn().mockResolvedValueOnce(firstResponse).mockResolvedValue(finalResponse)

      await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(finalResponse)

      expect(firstResponse.bodyUsed).toBe(true)
      expect(finalResponse.bodyUsed).toBe(false)
      await expect(finalResponse.text()).resolves.toBe('final failure')
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
  })

  describe('caller cancellation', () => {
    it('does not retry caller cancellation', async () => {
      const fetchImplementation = createPendingFetch()
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      const request = withRetry(fetchImplementation, 2)('/flags', { signal: controller.signal })

      controller.abort(reason)

      await expect(request).rejects.toBe(reason)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('rejects when cancellation races with response cleanup', async () => {
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      const cancellation = createDeferred<void>()
      const retryableResponse = new Response(
        new ReadableStream({
          cancel() {
            return cancellation.promise
          },
        }),
        { status: 500 }
      )
      const fetchImplementation = jest.fn().mockResolvedValue(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags', { signal: controller.signal })
      const expectation = expect(request).rejects.toBe(reason)

      await Promise.resolve()
      expect(retryableResponse.bodyUsed).toBe(true)
      controller.abort(reason)
      cancellation.resolve()

      await expectation
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('rejects when cancellation occurs during retry backoff', async () => {
      jest.useFakeTimers()
      jest.mocked(Math.random).mockReturnValue(0.5)
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      const retryableResponse = new Response('unavailable', { status: 500 })
      const fetchImplementation = jest.fn().mockResolvedValue(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags', { signal: controller.signal })
      const expectation = expect(request).rejects.toBe(reason)

      await jest.advanceTimersByTimeAsync(0)
      expect(retryableResponse.bodyUsed).toBe(true)
      controller.abort(reason)

      await expectation
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
      expect(jest.getTimerCount()).toBe(0)
    })

    it('rejects when response cleanup synchronously triggers caller cancellation', async () => {
      const controller = new AbortController()
      const reason = new DOMException('Configuration request superseded', 'AbortError')
      const retryableResponse = new Response(
        new ReadableStream({
          cancel() {
            controller.abort(reason)
          },
        }),
        { status: 500 }
      )
      const fetchImplementation = jest.fn().mockResolvedValue(retryableResponse)

      await expect(withRetry(fetchImplementation, 1)('/flags', { signal: controller.signal })).rejects.toBe(reason)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
    })

    it('never starts an attempt with an already-aborted caller signal', async () => {
      for (let microtaskDepth = 0; microtaskDepth <= 5; microtaskDepth += 1) {
        const controller = new AbortController()
        const reason = new DOMException('Configuration request superseded', 'AbortError')
        const abortedAtInvocation: boolean[] = []
        const fetchImplementation = jest.fn(async () => {
          abortedAtInvocation.push(controller.signal.aborted)
          return new Response(null, { status: abortedAtInvocation.length === 1 ? 500 : 200 })
        })
        const request = withRetry(fetchImplementation, 1)('/flags', { signal: controller.signal })
        let abortAfterMicrotasks = Promise.resolve()
        for (let depth = 0; depth < microtaskDepth; depth += 1) {
          abortAfterMicrotasks = abortAfterMicrotasks.then(() => undefined)
        }
        void abortAfterMicrotasks.then(() => controller.abort(reason))

        await request.catch(() => undefined)

        expect(abortedAtInvocation).not.toContain(true)
      }
    })
  })

  describe('response cleanup', () => {
    it('does not block retries on response cleanup that never settles', async () => {
      const retryableResponse = new Response(
        new ReadableStream({
          cancel() {
            return new Promise<void>(() => undefined)
          },
        }),
        { status: 500 }
      )
      const successfulResponse = new Response(null, { status: 200 })
      const fetchImplementation = jest
        .fn()
        .mockResolvedValueOnce(retryableResponse)
        .mockResolvedValue(successfulResponse)
      const request = withRetry(fetchImplementation, 1)('/flags')

      await Promise.resolve()
      await Promise.resolve()

      expect(fetchImplementation).toHaveBeenCalledTimes(2)
      await expect(request).resolves.toBe(successfulResponse)
    })

    it('continues retrying when response cleanup fails', async () => {
      const error = new Error('Stream cleanup failed')
      const retryableResponse = new Response(
        new ReadableStream({
          cancel() {
            throw error
          },
        }),
        { status: 500 }
      )
      const successfulResponse = new Response(null, { status: 200 })
      const fetchImplementation = jest
        .fn()
        .mockResolvedValueOnce(retryableResponse)
        .mockResolvedValue(successfulResponse)

      await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(successfulResponse)
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    })
  })

  describe('retry delay', () => {
    it('honors Retry-After on HTTP 503 responses', async () => {
      jest.useFakeTimers()
      jest.mocked(Math.random).mockReturnValue(0.5)
      const retryableResponse = new Response(null, { headers: { 'retry-after': '1' }, status: 503 })
      const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags')

      await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 1_050)
    })

    it.each(['0', 'Wed, 21 Oct 2015 07:28:00 GMT'])(
      'uses jittered backoff when Retry-After is immediate or in the past: %s',
      async (retryAfter) => {
        jest.useFakeTimers()
        jest.mocked(Math.random).mockReturnValue(0.5)
        const retryableResponse = new Response(null, { headers: { 'retry-after': retryAfter }, status: 503 })
        const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
        const request = withRetry(fetchImplementation, 1)('/flags')

        await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 50)
      }
    )

    it('uses an HTTP-date Retry-After value as a minimum before jittered backoff', async () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date('2026-08-28T16:00:00.000Z'))
      jest.mocked(Math.random).mockReturnValue(0.5)
      const retryableResponse = new Response(null, {
        headers: { 'retry-after': 'Fri, 28 Aug 2026 16:00:01 GMT' },
        status: 503,
      })
      const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags')

      await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 1_050)
    })

    it('does not retry when Retry-After exceeds the supported delay', async () => {
      const response = new Response('scheduled maintenance', {
        headers: { 'retry-after': '31' },
        status: 503,
      })
      const fetchImplementation = jest.fn().mockResolvedValue(response)

      await expect(withRetry(fetchImplementation, 1)('/flags')).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledTimes(1)
      expect(response.bodyUsed).toBe(false)
      await expect(response.text()).resolves.toBe('scheduled maintenance')
    })

    it('ignores Retry-After on retryable statuses other than HTTP 503', async () => {
      jest.useFakeTimers()
      jest.mocked(Math.random).mockReturnValue(0.5)
      const retryableResponse = new Response(null, { headers: { 'retry-after': '10' }, status: 500 })
      const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags')

      await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 50)
    })

    it.each(['', ' ', '1.5', '1e3', '-1', 'not-a-date'])(
      'uses backoff for malformed Retry-After value %j',
      async (retryAfter) => {
        jest.useFakeTimers()
        jest.mocked(Math.random).mockReturnValue(0.5)
        const retryableResponse = new Response(null, { headers: { 'retry-after': retryAfter }, status: 503 })
        const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
        const request = withRetry(fetchImplementation, 1)('/flags')

        await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 50)
      }
    )

    it('uses randomized exponential backoff without Retry-After', async () => {
      jest.useFakeTimers()
      jest.mocked(Math.random).mockReturnValue(0.5)
      const retryableResponse = new Response(null, { status: 503 })
      const { fetchImplementation, successfulResponse } = createResponseSequence(retryableResponse)
      const request = withRetry(fetchImplementation, 1)('/flags')

      await expectRetryAfterDelay(request, fetchImplementation, successfulResponse, 50)
    })
  })

  describe('RequestInit body validation', () => {
    it('rejects a non-replayable RequestInit body stream', async () => {
      const body = new ReadableStream()

      await expect(withRetry(globalThis.fetch, 1)('/flags', { body } as RequestInit)).rejects.toThrow(
        'withRetry cannot replay a RequestInit body stream; pass a Request with a cloneable body'
      )
    })

    it('passes a RequestInit body stream through when retries are disabled', async () => {
      const body = new ReadableStream()
      const response = new Response(null, { status: 200 })
      const fetchImplementation = jest.fn().mockResolvedValue(response)

      await expect(withRetry(fetchImplementation, 0)('/flags', { body } as RequestInit)).resolves.toBe(response)
      expect(fetchImplementation).toHaveBeenCalledWith('/flags', { body })
    })

    it('rejects a stream-like RequestInit body from another realm', async () => {
      const body = runInNewContext('new (class ForeignReadableStream { getReader() {} })()') as BodyInit
      const fetchImplementation = jest.fn()

      await expect(withRetry(fetchImplementation, 1)('/flags', { body } as RequestInit)).rejects.toThrow(
        'withRetry cannot replay a RequestInit body stream; pass a Request with a cloneable body'
      )
      expect(fetchImplementation).not.toHaveBeenCalled()
    })
  })

  describe('wrapper composition', () => {
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
  })

  describe('input validation', () => {
    it.each([-1, 1.5, 11, 2 ** 53 + 2, Number.POSITIVE_INFINITY])('rejects an invalid retry count of %s', (retries) => {
      expect(() => withRetry(globalThis.fetch, retries)).toThrow(
        new RangeError('retries must be an integer between 0 and 10')
      )
    })
  })
})
