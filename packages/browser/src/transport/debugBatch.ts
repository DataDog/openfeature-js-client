import type { EndpointBuilder, HttpRequest, PageMayExitEvent, Payload, RawError } from '@datadog/browser-core'
import {
  fetch as browserFetch,
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  monitor,
  Observable,
} from '@datadog/browser-core'
// Pinned browser-core 7.1.0 does not expose response statuses on HttpRequest.observable.
// Reuse its retry state machine; observe only this client's send strategy, never global fetch.
import { newRetryState, sendWithRetryStrategy } from '@datadog/browser-core/cjs/transport/sendWithRetryStrategy'
import { bindEventCorrelation, type DebugLogger, debugUrl, eventCorrelation, NO_DEBUG } from '../debug'

export function createTrackedRequest(
  endpoint: EndpointBuilder,
  reportError: (error: RawError) => void,
  debug: DebugLogger
): HttpRequest {
  if (!debug.enabled) return createHttpRequest([endpoint], reportError)
  const observable: HttpRequest['observable'] = new Observable()
  const state = newRetryState<Payload>()
  const ids = new WeakMap<Payload, number>()
  let sequence = 0
  const admittedAt = new WeakMap<Payload, number>()
  let nextAttemptAt: number | undefined
  const id = (payload: Payload) => {
    if (!admittedAt.has(payload)) admittedAt.set(payload, performance.now())
    if (!ids.has(payload)) ids.set(payload, ++sequence)
    return eventCorrelation(payload)?.batchId ?? ids.get(payload)
  }
  observable.subscribe((event) => {
    debug.event('upload.queue_result', () => ({
      batchId: id(event.payload),
      outcome:
        event.type === 'queue-full'
          ? 'dropped_queue_full'
          : event.type === 'failure'
            ? 'retryable_failure'
            : 'terminal_response',
      bandwidth: event.bandwidth,
      retry: event.payload.retry,
      // The library's "success" notification is terminal, not necessarily HTTP acceptance.
    }))
  })
  const send = (payload: Payload, onResponse?: (response: { status: number; type?: ResponseType }) => void) => {
    const started = performance.now()
    nextAttemptAt = undefined
    const url = endpoint.build('fetch', payload)
    debug.event('upload.started', () => ({
      batchId: id(payload),
      endpoint: debugUrl(url),
      bytesCount: payload.bytesCount,
      payload: payload.data,
      attempt: (payload.retry?.count ?? 0) + 1,
    }))
    browserFetch(url, { method: 'POST', body: payload.data, mode: 'cors' })
      .then(
        monitor((response: Response) => {
          const retryable =
            response.type !== 'opaque' &&
            ((response.status === 0 && !navigator.onLine) ||
              response.status === 408 ||
              response.status === 429 ||
              response.status >= 500)
          debug.event('upload.completed', () => ({
            batchId: id(payload),
            httpStatus: response.status,
            responseType: response.type,
            durationMs: performance.now() - started,
            outcome:
              response.status >= 200 && response.status < 300
                ? 'intake_accepted'
                : retryable && onResponse
                  ? 'retry_pending'
                  : 'dropped',
            backendProcessing: 'not_observable',
          }))
          try {
            void response
              .clone()
              .text()
              .then(
                (body) =>
                  debug.event('upload.response_body', () => ({
                    batchId: id(payload),
                    httpStatus: response.status,
                    body,
                  })),
                (error) => debug.event('upload.response_body_unavailable', () => ({ batchId: id(payload), error }))
              )
          } catch {}
          onResponse?.({ status: response.status, type: response.type })
          nextAttemptAt = state.transportStatus === 2 ? Date.now() + state.currentBackoffTime : undefined
          reportQueue()
        })
      )
      .catch(
        monitor((error) => {
          debug.event('upload.completed', () => ({
            batchId: id(payload),
            httpStatus: null,
            transportStatus: 0,
            error,
            durationMs: performance.now() - started,
            cause: 'unknown_transport_failure',
            outcome: !navigator.onLine && onResponse ? 'retry_pending' : 'dropped',
            onlineHint: navigator.onLine,
          }))
          onResponse?.({ status: 0 })
          nextAttemptAt = state.transportStatus === 2 ? Date.now() + state.currentBackoffTime : undefined
          reportQueue()
        })
      )
  }
  const reportQueue = () =>
    debug.event('upload.queue_state', () => ({
      pendingBatches: state.queuedPayloads.size(),
      oldestPendingAgeMs: state.queuedPayloads.size()
        ? performance.now() - (admittedAt.get(state.queuedPayloads.first()) ?? performance.now())
        : 0,
      nextAttemptAt,
      nextAttemptTrigger: state.transportStatus === 2 ? 'backoff_timer' : 'available_bandwidth_or_inflight_completion',
      pendingBytes: state.queuedPayloads.bytesCount,
      backoffMs: state.currentBackoffTime,
      bandwidth: state.bandwidthMonitor.stats(),
    }))
  return {
    observable,
    send(payload) {
      id(payload)
      sendWithRetryStrategy(payload, state, send, endpoint.trackType, reportError, observable)
      reportQueue()
    },
    sendOnExit(payload) {
      if (payload.bytesCount < 16 * 1024) {
        try {
          const url = endpoint.build('beacon', payload)
          const queued = navigator.sendBeacon(url, payload.data)
          debug.event('upload.beacon', () => ({
            batchId: id(payload),
            endpoint: debugUrl(url),
            payload: payload.data,
            bytesCount: payload.bytesCount,
            outcome: queued ? 'browser_queued' : 'declined',
            serverAcknowledged: false,
          }))
          if (queued) return
        } catch (error) {
          debug.event('upload.beacon_failed', () => ({ batchId: id(payload), error }))
        }
      } else {
        debug.event('upload.beacon_skipped', () => ({
          batchId: id(payload),
          reason: 'size_limit',
          bytesCount: payload.bytesCount,
        }))
      }
      send(payload)
    },
  }
}

let transportInstances = 0

export function createTrackedBatch(
  endpoint: EndpointBuilder,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>,
  sessionExpireObservable: Observable<void>,
  debug: DebugLogger = NO_DEBUG
) {
  debug = debug.child({ transportInstanceId: ++transportInstances })
  let batchId = 1
  let flushingBatchId = 1
  let pendingSince: number | undefined
  let currentMessage: Record<string, unknown> | undefined
  const encoder = createIdentityEncoder()
  const flushController = createFlushController({ pageMayExitObservable, sessionExpireObservable })
  const subscriptions: { unsubscribe(): void }[] = []
  if (debug.enabled) {
    const estimate = encoder.estimateEncodedBytesCount.bind(encoder)
    encoder.estimateEncodedBytesCount = (data) => {
      const bytes = estimate(data)
      if (bytes >= 256 * 1024)
        debug.event('batch.dropped', () => ({
          reason: 'message_size_limit',
          bytesCount: bytes,
          payload: data,
          ...currentMessage,
        }))
      return bytes
    }
    const write = encoder.write.bind(encoder)
    encoder.write = (data, callback) => {
      pendingSince ??= performance.now()
      debug.event('batch.enqueued', () => ({
        batchId,
        ...currentMessage,
        payload: data,
        messagesCountBefore: flushController.messagesCount,
      }))
      return write(data, callback)
    }
    subscriptions.push(
      flushController.flushObservable.subscribe((event) => {
        flushingBatchId = batchId++
        const ageMs = pendingSince === undefined ? 0 : performance.now() - pendingSince
        pendingSince = undefined
        debug.event('batch.flushed', () => ({ ...event, batchId: flushingBatchId, pendingAgeMs: ageMs }))
      }),
      pageMayExitObservable.subscribe((event) =>
        debug.event('lifecycle.page_exit', () => ({ ...event, delivery: 'best_effort' }))
      )
    )
  }
  const request = createTrackedRequest(endpoint, reportError, debug)
  const correlatedRequest: HttpRequest = !debug.enabled
    ? request
    : {
        ...request,
        send(payload) {
          bindEventCorrelation(payload, { batchId: flushingBatchId })
          request.send(payload)
        },
        sendOnExit(payload) {
          bindEventCorrelation(payload, { batchId: flushingBatchId })
          request.sendOnExit(payload)
        },
      }
  const batch = createBatch({ encoder, request: correlatedRequest, flushController })
  return {
    ...batch,
    add(...args: Parameters<typeof batch.add>) {
      if (!debug.enabled) return batch.add(...args)
      const previous = currentMessage
      currentMessage = eventCorrelation(args[0])
      try {
        return batch.add(...args)
      } finally {
        currentMessage = previous
      }
    },
    stop() {
      debug.event('batch.stopped', () => ({
        pendingMessages: flushController.messagesCount,
        inFlightRequests: 'may_continue',
      }))
      subscriptions.forEach((subscription) => {
        subscription.unsubscribe()
      })
      batch.stop()
    },
  }
}
