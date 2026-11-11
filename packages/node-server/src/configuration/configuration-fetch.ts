import { timeStampNow } from '@datadog/flagging-core'

export type ConfigurationFetchErrorCode =
  'invalid_options' | 'http' | 'invalid_response' | 'decode' | 'transport' | 'cancelled' | 'timeout'

/** A configuration-loading failure, not an OpenFeature evaluation error. */
export class ConfigurationFetchError extends Error {
  constructor(
    readonly code: ConfigurationFetchErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ConfigurationFetchError'
  }
}

function abortError(signal?: AbortSignal): ConfigurationFetchError {
  return signal?.reason?.name === 'TimeoutError'
    ? new ConfigurationFetchError('timeout', 'Configuration fetch timed out')
    : new ConfigurationFetchError('cancelled', 'Configuration fetch cancelled')
}

// Raw errors can contain credentials or response bytes. Copy only a fixed diagnostic code.
const TRANSPORT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export function transportError(message: string, error: unknown): ConfigurationFetchError {
  const { code, cause } = (error ?? {}) as { code?: unknown; cause?: { code?: unknown } }
  const known = [cause?.code, code].find((value) => typeof value === 'string' && TRANSPORT_CODES.has(value))
  return new ConfigurationFetchError('transport', known ? `${message} (${known})` : message)
}

export function invalidOption(option: string): ConfigurationFetchError {
  return new ConfigurationFetchError('invalid_options', `Invalid configuration fetch options: ${option}`)
}

export interface ConfigurationTransportOptions {
  /** Request and response-body deadline in milliseconds. Defaults to 5000. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Fetch-compatible transport. Must honor the supplied signal and redirect policy. */
  fetch?: typeof globalThis.fetch
}

export function validateTransportOptions(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  requestFetch: typeof fetch
): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw invalidOption('timeoutMs')
  if (typeof requestFetch !== 'function') throw invalidOption('fetch')
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  )
    throw invalidOption('signal')
}

/** Keep credentials, deadlines and response cleanup consistent across configuration endpoints. */
export async function requestConfiguration<T>(
  url: string,
  init: RequestInit,
  options: Required<Pick<ConfigurationTransportOptions, 'fetch' | 'timeoutMs'>> &
    Pick<ConfigurationTransportOptions, 'signal'>,
  read: (response: Response, fetchedAt: ReturnType<typeof timeStampNow>, checkAborted: () => void) => Promise<T>
): Promise<T> {
  const { fetch: requestFetch, timeoutMs, signal } = options
  if (signal?.aborted) throw abortError(signal)
  const controller = new AbortController()
  const cancel = () => controller.abort(abortError(signal))
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new ConfigurationFetchError('timeout', 'Configuration fetch timed out')),
    timeoutMs
  )
  const fetchedAt = timeStampNow()
  let response: Response | undefined
  try {
    try {
      response = await requestFetch(url, {
        ...init,
        signal: controller.signal,
        // Never forward a credential to a redirect destination.
        redirect: 'manual',
      })
    } catch (error) {
      throw transportError('Configuration request failed', error)
    }
    controller.signal.throwIfAborted()
    if (response.status !== 200) {
      throw new ConfigurationFetchError('http', `Configuration fetch returned HTTP ${response.status}`, response.status)
    }
    const result = await read(response, fetchedAt, () => controller.signal.throwIfAborted())
    controller.signal.throwIfAborted()
    return result
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof ConfigurationFetchError) throw error
    throw transportError('Configuration request failed', error)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    controller.abort()
    // Cleanup must not replace the result or wait for a custom transport to settle.
    try {
      const body = response?.body as (ReadableStream & { destroy?: () => void }) | null | undefined
      if (body && !response?.bodyUsed) {
        if (typeof body.cancel === 'function') void body.cancel().catch(() => {})
        else body.destroy?.()
      }
    } catch {
      // Custom transports can throw synchronously during cleanup.
    }
  }
}
