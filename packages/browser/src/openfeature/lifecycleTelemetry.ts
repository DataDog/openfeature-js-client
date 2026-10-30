import type { FlaggingConfiguration } from '../domain/configuration'
import { createFlagEvaluationTransport, type FlagEvaluationTransport } from './flagEvaluationTransport'

type Milestone = { elapsed_ms: number }
type InitializationTiming = { started_at_ms: number; duration_ms: number }
type FinalTiming = InitializationTiming & { final: true }
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
        final: false
        reason: 'page_exit' | 'provider_closed'
        milestones: { configuration_received?: Milestone }
      }
    }
  | { event_type: 'provider_error'; error_code: 'CONFIG_FETCH_FAILED' }

/** One initialization attempt and at most one later fetch error, using the evaluation transport. */
export function createLifecycleTelemetry(
  configuration: FlaggingConfiguration,
  sharedTransport?: FlagEvaluationTransport
) {
  const startedAt = Date.now()
  const monotonicStart = performance.now()
  let configurationReceived: Milestone | undefined
  let snapshotSent = false
  let settled = false
  let providerErrorSent = false
  let stopped = false
  const transport = sharedTransport ?? createFlagEvaluationTransport(configuration)
  const batch = transport.batch
  const pageSubscription = batch.flushController.preparePageExitFlushObservable.subscribe(() => {
    snapshot('page_exit')
  })

  function elapsed() {
    return Math.max(0, performance.now() - monotonicStart)
  }

  function emit(diagnostic: Diagnostic) {
    try {
      const identity = bounded(configuration.applicationId, 128)
        ? { application_id: configuration.applicationId }
        : bounded(configuration.service, 200)
          ? { service_id: configuration.service }
          : undefined
      if (!identity || !bounded(configuration.env, 200)) {
        return
      }
      const timestamp = Date.now()
      if (
        'initialization' in diagnostic &&
        (timestamp < startedAt || diagnostic.initialization.duration_ms > 86_400_000)
      ) {
        return
      }
      const event = {
        schema_version: 1,
        type: 'sdk_diagnostic',
        payload: {
          ...diagnostic,
          timestamp,
          sdk_name: 'dd-openfeature-browser',
          sdk_version: __BUILD_ENV__SDK_VERSION__,
          ...identity,
          environment: configuration.env,
        },
      }
      batch.add(event)
    } catch {
      // Diagnostic queue failures must not affect flag evaluation.
    }
  }

  function snapshot(reason: 'page_exit' | 'provider_closed') {
    if (stopped || settled || snapshotSent) return
    const duration = elapsed()
    snapshotSent = true

    emit({
      event_type: 'sdk_initialization',
      initialization: {
        outcome: 'incomplete',
        started_at_ms: startedAt,
        duration_ms: duration,
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

    const timing = {
      started_at_ms: startedAt,
      duration_ms: elapsed(),
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

      try {
        if (!sharedTransport) transport.stop()
      } finally {
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
