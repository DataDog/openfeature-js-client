type Fetch = typeof globalThis.fetch

// Browser timers convert delays to signed 32-bit integers; larger values can fire immediately.
const MAX_SET_TIMEOUT_DELAY_MS = 2_147_483_647
// Keep retry loops operationally bounded and below the point where integer increments lose precision.
const MAX_RETRIES = 10
const MAX_BACKOFF_MS = 30_000
const MAX_RETRY_AFTER_MS = 30_000
const INITIAL_BACKOFF_MS = 100

function isRequest(input: Parameters<Fetch>[0]): input is Request {
  return (
    typeof input === 'object' &&
    input !== null &&
    'clone' in input &&
    typeof input.clone === 'function' &&
    'signal' in input
  )
}

function getRequestSignal(input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): AbortSignal | undefined {
  if (init?.signal === null) {
    return undefined
  }
  if (init?.signal !== undefined) {
    return init.signal
  }
  return isRequest(input) ? input.signal : undefined
}

function validateIntegerInRange(value: number, name: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}`)
  }
}

async function bufferResponse(response: Response): Promise<void> {
  if (response.body) {
    await response.clone().arrayBuffer()
  }
}

/**
 * Wraps a Fetch-compatible implementation with a timeout for each request.
 *
 * The timeout includes response-body download. A timeout of zero disables the timer while preserving caller cancellation.
 * The response body is buffered before this wrapper resolves.
 */
export function withTimeout(fetchImplementation: Fetch, timeoutMs: number): Fetch {
  validateIntegerInRange(timeoutMs, 'timeoutMs', MAX_SET_TIMEOUT_DELAY_MS)

  return async (input, init) => {
    const controller = new AbortController()
    const requestSignal = getRequestSignal(input, init)
    const abortFromRequest = () => controller.abort(requestSignal?.reason)

    if (requestSignal?.aborted) {
      abortFromRequest()
    } else {
      requestSignal?.addEventListener('abort', abortFromRequest, { once: true })
    }

    const timeout =
      timeoutMs === 0
        ? undefined
        : setTimeout(() => {
            controller.abort(new DOMException(`The request timed out after ${timeoutMs} ms`, 'TimeoutError'))
          }, timeoutMs)

    try {
      const response = await fetchImplementation(input, { ...init, signal: controller.signal })
      await bufferResponse(response)
      return response
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? error
      }
      throw error
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      requestSignal?.removeEventListener('abort', abortFromRequest)
    }
  }
}

function isRetryableResponse(response: Response): boolean {
  return response.status === 408 || response.status >= 500
}

function isRetryableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ['TypeError', 'TimeoutError'].includes(String(error.name))
  )
}

function getRetryAfterMs(response: Response): number | undefined {
  if (response.status !== 503) {
    return undefined
  }

  const value = response.headers.get('retry-after')
  if (value === null) {
    return undefined
  }

  const trimmedValue = value.trim()
  if (/^\d+$/.test(trimmedValue)) {
    const seconds = Number(trimmedValue)
    return seconds * 1_000
  }
  if (trimmedValue === '' || Number.isFinite(Number(trimmedValue))) {
    return undefined
  }

  const date = Date.parse(trimmedValue)
  if (Number.isNaN(date)) {
    return undefined
  }
  return Math.max(date - Date.now(), 0)
}

function getBackoffMs(attempt: number): number {
  const maximum = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.floor(Math.random() * maximum)
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }
  if (delayMs === 0) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      finish()
      reject(signal?.reason)
    }
    const timeout = setTimeout(() => {
      finish()
      resolve()
    }, delayMs)

    signal?.addEventListener('abort', abort, { once: true })
  })
}

function validateReplayableBody(init?: RequestInit): void {
  if (
    typeof init?.body === 'object' &&
    init.body !== null &&
    'getReader' in init.body &&
    typeof init.body.getReader === 'function'
  ) {
    throw new TypeError('withRetry cannot replay a RequestInit body stream; pass a Request with a cloneable body')
  }
}

/**
 * Wraps a Fetch-compatible implementation with delayed retries for transient failures.
 *
 * Fetch TypeErrors, timeout errors, HTTP 408, and HTTP 5xx responses are retried. Caller cancellation is never retried.
 */
export function withRetry(fetchImplementation: Fetch, retries: number): Fetch {
  validateIntegerInRange(retries, 'retries', MAX_RETRIES)

  return async (input, init) => {
    if (retries === 0) {
      return fetchImplementation(input, init)
    }

    validateReplayableBody(init)
    const requestSignal = getRequestSignal(input, init)
    const requestTemplate = isRequest(input) && init?.body == null ? input.clone() : undefined

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0 && requestSignal?.aborted) {
        throw requestSignal.reason
      }

      const attemptInput = attempt === 0 || !requestTemplate ? input : requestTemplate.clone()
      let response: Response
      try {
        response = await fetchImplementation(attemptInput, init)
      } catch (error) {
        if (requestSignal?.aborted || attempt === retries || !isRetryableError(error)) {
          throw error
        }
        await waitForRetry(getBackoffMs(attempt), requestSignal)
        continue
      }

      if (!isRetryableResponse(response) || attempt === retries || requestSignal?.aborted) {
        return response
      }

      const retryAfterMs = getRetryAfterMs(response)
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        return response
      }
      const delayMs = (retryAfterMs ?? 0) + getBackoffMs(attempt)
      void response.body?.cancel().catch(() => undefined)
      await waitForRetry(delayMs, requestSignal)
    }
  }
}
