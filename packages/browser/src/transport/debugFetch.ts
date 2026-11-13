import { bindDebugRequest, bindDebugSignal, type DebugLogger, debugUrl } from '../debug'
import { describeFetch } from './fetch'

/** Observe the actual response without consuming the caller's stream or delaying its completion. */
export async function debugFetch(
  implementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  debug: DebugLogger,
  hasAssignmentCredential = false,
  captureResponseBody = true
): Promise<Response> {
  if (!debug.enabled) return implementation(url, init)
  if (hasAssignmentCredential) {
    // Retry/timeout wrappers share this logger. Custom transport errors can carry
    // request headers in arbitrary properties, so omit them before any observer.
    const original = debug
    debug = {
      ...original,
      event(name, fields) {
        original.event(name, () => {
          const details = fields?.() as Record<string, unknown> | undefined
          return details && 'error' in details ? { ...details, error: 'Assignment transport details omitted' } : details
        })
      },
    }
    if (init.signal) bindDebugSignal(init.signal, debug)
  }
  bindDebugRequest(init, debug)
  const started = performance.now()
  debug.event('fetch.started', () => ({
    endpoint: debugUrl(url),
    method: init.method,
    body: init.body,
    headerNames: headerNames(init.headers).filter((name) => name.toLowerCase() !== 'dd-assignment-token'),
    policy: describeFetch(implementation),
  }))
  try {
    const response = await implementation(url, init)
    debug.event('fetch.completed', () => ({
      httpStatus: response.status,
      responseType: response.type,
      ok: response.ok,
      durationMs: performance.now() - started,
      requestId: hasAssignmentCredential
        ? undefined
        : (response.headers?.get('x-request-id') ?? response.headers?.get('dd-request-id')),
      retryAfter: hasAssignmentCredential ? undefined : response.headers?.get('retry-after'),
      flagSelectionIgnored: hasAssignmentCredential ? undefined : response.headers?.get('DD-Flag-Selection-Ignored'),
    }))
    // Credentialed responses may echo headers, even in malformed/error bodies.
    // The caller logs the decoded configuration after the parsing boundary.
    if (hasAssignmentCredential || !captureResponseBody) return response
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

function headerNames(headers: HeadersInit | undefined): string[] {
  if (headers instanceof Headers) {
    const names: string[] = []
    headers.forEach((_value, name) => {
      names.push(name)
    })
    return names
  }
  return Array.isArray(headers) ? headers.map(([name]) => name) : Object.keys(headers ?? {})
}
