import type { Context, EndpointBuilder, PageMayExitEvent } from '@datadog/browser-core'
import { Observable, validateAndBuildConfiguration } from '@datadog/browser-core'
import { createDebugLogger } from '../../src/debug'
import { createTrackedBatch, createTrackedRequest } from '../../src/transport/debugBatch'

const endpoint = {
  trackType: 'exposures',
  build: () => 'https://example.test/intake?dd-api-key=transport-secret',
} as unknown as EndpointBuilder
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const response = (status: number) =>
  ({ status, type: 'basic', clone: () => ({ text: async () => 'response details' }) }) as Response

describe('debug event transport', () => {
  let log: jest.SpyInstance
  let fetch: jest.SpyInstance
  const events = (name: string) =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((record) => record.event === name)
  beforeEach(() => {
    jest.useFakeTimers()
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response(202))
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValue(true),
    })
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it.each([200, 202, 400, 401, 403, 413])('reports the actual terminal HTTP %s disposition', async (status) => {
    fetch.mockResolvedValue(response(status))
    createTrackedRequest(endpoint, jest.fn(), createDebugLogger(true)).send({ data: '{"raw":"event"}', bytesCount: 15 })
    await settle()
    expect(events('upload.completed')[0].details).toMatchObject({
      httpStatus: status,
      outcome: status < 300 ? 'intake_accepted' : 'dropped',
    })
    expect(events('upload.response_body')[0].details.body).toBe('response details')
    expect(JSON.stringify(log.mock.calls)).not.toContain('transport-secret')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('preserves retry behavior with debug=%s', async (enabled) => {
    fetch.mockResolvedValueOnce(response(429)).mockResolvedValue(response(202))
    createTrackedRequest(endpoint, jest.fn(), createDebugLogger(enabled)).send({ data: '{}', bytesCount: 2 })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledTimes(2)
    if (enabled) {
      expect(events('upload.queue_state').some((r) => typeof r.details.nextAttemptAt === 'number')).toBe(true)
      expect(events('upload.completed').map((r) => r.details.outcome)).toEqual(['retry_pending', 'intake_accepted'])
      expect(events('upload.started').map((r) => r.details.attempt)).toEqual([1, 2])
      expect(events('upload.started')[0].details.batchId).toBe(events('upload.started')[1].details.batchId)
    } else expect(log).not.toHaveBeenCalled()
  })

  it('reports ambiguous online transport failures under the existing drop policy', async () => {
    jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    fetch.mockRejectedValue(new TypeError('CORS or network'))
    createTrackedRequest(endpoint, jest.fn(), createDebugLogger(true)).send({ data: '{}', bytesCount: 2 })
    await settle()
    expect(events('upload.completed')[0].details).toMatchObject({
      outcome: 'dropped',
      cause: 'unknown_transport_failure',
      httpStatus: null,
      transportStatus: 0,
    })
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each(['fetch', 'beacon'] as const)('omits client credentials in real string-proxy %s URLs', async (mode) => {
    const proxyEndpoint = validateAndBuildConfiguration({
      clientToken: 'proxy-client-secret',
      proxy: 'https://proxy.test/intake',
    })!.exposuresEndpointBuilder
    const request = createTrackedRequest(proxyEndpoint, jest.fn(), createDebugLogger(true))
    if (mode === 'fetch') request.send({ data: '{}', bytesCount: 2 })
    else request.sendOnExit({ data: '{}', bytesCount: 2 })
    await settle()
    const url = events(mode === 'fetch' ? 'upload.started' : 'upload.beacon')[0].details.endpoint
    expect(decodeURIComponent(url)).toContain('/api/v2/exposures')
    expect(JSON.stringify(log.mock.calls)).not.toContain('proxy-client-secret')
  })

  it('logs queue overflow', () => {
    fetch.mockImplementation(() => new Promise(() => {}))
    const request = createTrackedRequest(endpoint, jest.fn(), createDebugLogger(true))
    request.send({ data: '{}', bytesCount: 80 * 1024 })
    request.send({ data: '{}', bytesCount: 20 * 1024 * 1024 })
    request.send({ data: '{}', bytesCount: 80 * 1024 })
    expect(events('upload.queue_result').some((r) => r.details.outcome === 'dropped_queue_full')).toBe(true)
  })

  it('distinguishes browser-queued beacon from acknowledged delivery', () => {
    createTrackedRequest(endpoint, jest.fn(), createDebugLogger(true)).sendOnExit({ data: '{}', bytesCount: 2 })
    expect(events('upload.beacon')[0].details).toMatchObject({ outcome: 'browser_queued', serverAcknowledged: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['declined', 'throwing', 'oversize'])('falls back to fetch when beacon is %s', async (mode) => {
    const beacon = navigator.sendBeacon as jest.Mock
    if (mode === 'declined') beacon.mockReturnValue(false)
    if (mode === 'throwing')
      beacon.mockImplementation(() => {
        throw new Error('beacon unavailable')
      })
    createTrackedRequest(endpoint, jest.fn(), createDebugLogger(true)).sendOnExit({
      data: '{}',
      bytesCount: mode === 'oversize' ? 16384 : 2,
    })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(events('upload.completed')[0].details.outcome).toBe('intake_accepted')
  })

  it('observes actual serialization and flush, and removes lifecycle subscriptions', async () => {
    const page = new Observable<PageMayExitEvent>()
    const expire = new Observable<void>()
    const batch = createTrackedBatch(endpoint, jest.fn(), page, expire, createDebugLogger(true))
    const read = jest.fn(() => 'original')
    const message = Object.defineProperty({}, 'raw', { enumerable: true, get: read })
    batch.add(message as Context)
    expect(read).toHaveBeenCalledTimes(1)
    expire.notify()
    await settle()
    expect(events('batch.flushed')[0].details).toMatchObject({ reason: 'session_expire', messagesCount: 1 })
    expect(events('upload.started')[0].details.payload).toContain('original')
    expect(events('batch.enqueued')[0].details.batchId).toBe(events('upload.started')[0].details.batchId)
    expect(events('batch.flushed')[0].details.pendingAgeMs).toBeGreaterThanOrEqual(0)
    batch.stop()
    expect(jest.getTimerCount()).toBe(0)
    log.mockClear()
    page.notify({ reason: 'before_unload' } as PageMayExitEvent)
    expect(log).not.toHaveBeenCalled()
  })
})
