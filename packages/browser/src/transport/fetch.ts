type Fetch = typeof globalThis.fetch

function getRequestSignal(input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): AbortSignal | undefined {
  if (init?.signal) {
    return init.signal
  }
  return typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

/**
 * Wraps a Fetch-compatible implementation with a timeout for each request.
 *
 * The caller's AbortSignal is preserved and can still cancel the request before the timeout.
 */
export function withTimeout(fetchImplementation: Fetch, timeoutMs: number): Fetch {
  validateNonNegativeInteger(timeoutMs, 'timeoutMs')

  return async (input, init) => {
    const controller = new AbortController()
    const requestSignal = getRequestSignal(input, init)
    const abortFromRequest = () => controller.abort(requestSignal?.reason)

    if (requestSignal?.aborted) {
      abortFromRequest()
    } else {
      requestSignal?.addEventListener('abort', abortFromRequest, { once: true })
    }

    const timeout = setTimeout(() => {
      controller.abort(new DOMException(`The request timed out after ${timeoutMs} ms`, 'TimeoutError'))
    }, timeoutMs)

    try {
      return await fetchImplementation(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
      requestSignal?.removeEventListener('abort', abortFromRequest)
    }
  }
}

function isRetryableResponse(response: Response): boolean {
  return response.status === 408 || response.status === 429 || response.status >= 500
}

/**
 * Wraps a Fetch-compatible implementation with immediate retries for transient failures.
 *
 * Network errors, HTTP 408, HTTP 429, and HTTP 5xx responses are retried. Caller cancellation is never retried.
 */
export function withRetry(fetchImplementation: Fetch, retries: number): Fetch {
  validateNonNegativeInteger(retries, 'retries')

  return async (input, init) => {
    const requestSignal = getRequestSignal(input, init)

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetchImplementation(input, init)
        if (!isRetryableResponse(response) || attempt === retries || requestSignal?.aborted) {
          return response
        }
        await response.body?.cancel()
      } catch (error) {
        if (requestSignal?.aborted || attempt === retries) {
          throw error
        }
      }
    }
  }
}
