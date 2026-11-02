import { bindDebugRequest, type DebugLogger, debugUrl } from '../debug'
import { describeFetch } from './fetch'

/** Observe the actual response without consuming the caller's stream or delaying its completion. */
export async function debugFetch(
  implementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  debug: DebugLogger
): Promise<Response> {
  if (!debug.enabled) return implementation(url, init)
  bindDebugRequest(init, debug)
  const started = performance.now()
  debug.event('fetch.started', () => ({
    endpoint: debugUrl(url),
    method: init.method,
    body: init.body,
    headerNames: Object.keys(init.headers ?? {}),
    policy: describeFetch(implementation),
  }))
  try {
    const response = await implementation(url, init)
    debug.event('fetch.completed', () => ({
      httpStatus: response.status,
      responseType: response.type,
      ok: response.ok,
      durationMs: performance.now() - started,
      requestId: response.headers?.get('x-request-id') ?? response.headers?.get('dd-request-id'),
      retryAfter: response.headers?.get('retry-after'),
      flagSelectionIgnored: response.headers?.get('DD-Flag-Selection-Ignored'),
    }))
    try {
      void response
        .clone()
        .text()
        .then(
          (body) => debug.event('fetch.response_body', () => ({ httpStatus: response.status, body })),
          (error) => debug.event('fetch.response_body_unavailable', () => ({ error }))
        )
    } catch (error) {
      debug.event('fetch.response_body_unavailable', () => ({ error }))
    }
    return response
  } catch (error) {
    debug.event('fetch.failed', () => ({
      error,
      durationMs: performance.now() - started,
      cancelled: init.signal?.aborted === true,
      cause: init.signal?.aborted ? 'caller_cancelled' : 'unknown_transport_failure',
      possibleChecks: ['connectivity', 'DNS/TLS', 'CORS', 'CSP', 'content_blocker', 'custom_transport'],
    }))
    throw error
  }
}
