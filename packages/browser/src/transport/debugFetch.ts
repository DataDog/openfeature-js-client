import { bindDebugRequest, type DebugEndpointSource, type DebugLogger, debugUrl } from '../debug'
import { describeFetch } from './fetch'

/** Observe the actual response without consuming the caller's stream or delaying its completion. */
export async function debugFetch(
  implementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  debug: DebugLogger,
  endpointSource: DebugEndpointSource = 'unknown'
): Promise<Response> {
  if (!debug.enabled) return implementation(url, init)
  bindDebugRequest(init, debug)
  const started = performance.now()
  debug.event('fetch.started', () => ({
    endpoint: debugUrl(url, endpointSource),
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
    }))
    // Transport responses may echo credentials; callers log only parsed configuration fields.
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
