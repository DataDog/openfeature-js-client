import {
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  createPageMayExitObservable,
  generateUUID,
  Observable,
  type PageMayExitEvent,
} from '@datadog/browser-core'
import type { FlaggingConfiguration } from '../domain/configuration'

type Milestone = { elapsed_ms: number }
type InitializationTiming = { started_at: number; duration_ms: number }
type FinalTiming = InitializationTiming & { sequence: 0 | 1; final: true }
type Diagnostic =
  | {
      event_type: 'sdk_initialization'
      error_code?: never
      initialization: FinalTiming & {
        outcome: 'ready'
        milestones: { configuration_received: Milestone; provider_ready: Milestone }
      }
    }
  | {
      event_type: 'sdk_initialization'
      error_code: 'INIT_FAILED'
      initialization: FinalTiming & { outcome: 'failed'; milestones: { configuration_received?: Milestone } }
    }
  | {
      event_type: 'sdk_initialization'
      error_code: 'CONFIG_FETCH_FAILED'
      initialization: FinalTiming & { outcome: 'cached_fallback'; milestones: { configuration_received?: never } }
    }
  | {
      event_type: 'sdk_initialization'
      error_code?: never
      initialization: InitializationTiming & {
        outcome: 'incomplete'
        sequence: 0
        final: false
        reason: 'deadline' | 'page_exit' | 'provider_closed'
        milestones: { configuration_received?: Milestone }
      }
    }
  | { event_type: 'provider_error'; error_code: 'CONFIG_FETCH_FAILED' }

/** Local diagnostics must never change provider behavior, even with a replaced console. */
export function logDiagnostic(message: string, details?: unknown): void {
  try {
    console.log('[Datadog Feature Flags]', message, details === undefined ? '' : JSON.stringify(details))
  } catch {
    // Diagnostic output is best effort and never uploaded.
  }
}

/** One initialization attempt and at most one later fetch error, in a separate JSONL batch. */
export function createLifecycleTelemetry(configuration: FlaggingConfiguration, debugMode = false) {
  function log(message: string, details?: unknown): void {
    if (debugMode) logDiagnostic(message, details)
  }

  const runtimeId = generateUUID()
  const startedAt = Date.now()
  const monotonicStart = performance.now()
  let configurationReceived: Milestone | undefined
  let snapshotSent = false
  let settled = false
  let providerErrorSent = false
  let stopped = false
  const flushOnClose = new Observable<void>()
  const pageExit = new Observable<PageMayExitEvent>()
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.flagEvaluationEndpointBuilder], () => {
      log('Lifecycle upload failed. Check the client token, site, network, and Content Security Policy.')
    }),
    flushController: createFlushController({
      pageMayExitObservable: pageExit,
      sessionExpireObservable: flushOnClose,
    }),
  })
  // Queue the snapshot before notifying the transport to flush on page exit.
  const pageSubscription = createPageMayExitObservable(configuration).subscribe((event) => {
    snapshot('page_exit')
    pageExit.notify(event)
  })
  let deadline = setTimeout(() => snapshot('deadline'), 30_000)

  function elapsed() {
    return Math.max(0, performance.now() - monotonicStart)
  }

  function emit(diagnostic: Diagnostic) {
    try {
      log(diagnostic.event_type, diagnostic)
      const identity = bounded(configuration.applicationId, 128)
        ? { application_id: configuration.applicationId }
        : bounded(configuration.service, 200)
          ? { service_id: configuration.service }
          : undefined
      if (!identity || !bounded(configuration.env, 200)) {
        log('Remote lifecycle diagnostics require an applicationId or service and an env.')
        return
      }
      const timestamp = Date.now()
      if (
        'initialization' in diagnostic &&
        (timestamp < startedAt || diagnostic.initialization.duration_ms > 86_400_000)
      ) {
        log('Initialization timing is outside the diagnostic contract.')
        return
      }
      const event = {
        schema_version: 1,
        type: 'sdk_diagnostic',
        payload: {
          ...diagnostic,
          timestamp,
          runtime_id: runtimeId,
          sdk_name: 'dd-openfeature-browser',
          sdk_version: __BUILD_ENV__SDK_VERSION__,
          ...identity,
          environment: configuration.env,
        },
      }
      if (new Blob([JSON.stringify(event)]).size > 2048) {
        log('Lifecycle event exceeds the diagnostic size limit.')
        return
      }
      // At most two initialization records and one provider error: below intake's 32-record limit.
      batch.add(event)
    } catch {
      log('Unable to queue lifecycle diagnostics. Flag evaluation is unaffected.')
    }
  }

  function snapshot(reason: 'deadline' | 'page_exit' | 'provider_closed') {
    if (stopped || settled || snapshotSent) return
    const duration = elapsed()
    if (reason === 'deadline' && duration < 30_000) {
      deadline = setTimeout(() => snapshot('deadline'), Math.ceil(30_000 - duration))
      return
    }
    snapshotSent = true
    clearTimeout(deadline)
    emit({
      event_type: 'sdk_initialization',
      initialization: {
        outcome: 'incomplete',
        started_at: startedAt,
        duration_ms: duration,
        sequence: 0,
        final: false,
        reason,
        milestones: configurationReceived ? { configuration_received: configurationReceived } : {},
      },
    })
  }

  function settle(outcome: 'ready' | 'failed' | 'cached_fallback') {
    if (stopped || settled) return
    // Readiness requires evidence of a fresh, usable configuration.
    if (outcome === 'ready' && !configurationReceived) return
    settled = true
    clearTimeout(deadline)
    const timing = {
      started_at: startedAt,
      duration_ms: elapsed(),
      sequence: snapshotSent ? (1 as const) : (0 as const),
      final: true as const,
    }
    if (outcome === 'ready' && configurationReceived) {
      emit({
        event_type: 'sdk_initialization',
        initialization: {
          ...timing,
          outcome,
          milestones: {
            configuration_received: configurationReceived,
            provider_ready: { elapsed_ms: timing.duration_ms },
          },
        },
      })
    } else if (outcome === 'failed') {
      emit({
        event_type: 'sdk_initialization',
        error_code: 'INIT_FAILED',
        initialization: {
          ...timing,
          outcome,
          milestones: configurationReceived ? { configuration_received: configurationReceived } : {},
        },
      })
    } else if (outcome === 'cached_fallback') {
      emit({
        event_type: 'sdk_initialization',
        error_code: 'CONFIG_FETCH_FAILED',
        initialization: { ...timing, outcome, milestones: {} },
      })
    }
  }

  return {
    configurationReceived() {
      if (!stopped && !settled) configurationReceived = { elapsed_ms: elapsed() }
    },
    settle,
    providerError() {
      if (stopped || !settled || providerErrorSent) return
      providerErrorSent = true
      emit({ event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED' })
    },
    stop() {
      if (stopped) return
      snapshot('provider_closed')
      stopped = true
      clearTimeout(deadline)
      try {
        if (batch.flushController.messagesCount > 0) flushOnClose.notify()
      } finally {
        batch.stop()
        pageSubscription.unsubscribe()
      }
    },
  }
}

function bounded(value: string | undefined, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value)
  )
}
