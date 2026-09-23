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

type ProgressEvent = 'sdk_init_started' | 'configuration_received' | 'provider_ready'
type FailureEvent = 'provider_error' | 'init_timeout' | 'init_failed'
const ERROR_CODES = {
  provider_error: 'CONFIG_FETCH_FAILED',
  init_timeout: 'INIT_TIMEOUT',
  init_failed: 'INIT_FAILED',
} as const

/** Local diagnostics must never change provider behavior, even with a replaced console. */
export function logDiagnostic(message: string, details?: unknown): void {
  try {
    console.log('[Datadog Feature Flags]', message, details === undefined ? '' : JSON.stringify(details))
  } catch {
    // Diagnostic output is best effort and never uploaded.
  }
}

/** A separate, bounded lifecycle batch; it does not require evaluation tracking or RUM initialization. */
export function createLifecycleTelemetry(configuration: FlaggingConfiguration, debugMode = false) {
  function log(message: string, details?: unknown): void {
    if (debugMode) logDiagnostic(message, details)
  }

  const runtimeId = generateUUID()
  const sent = new Set<ProgressEvent | FailureEvent>()
  const flushOnClose = new Observable<void>()
  const pageExit = new Observable<PageMayExitEvent>()
  const pageSubscription = createPageMayExitObservable(configuration).subscribe((event) => pageExit.notify(event))
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
  let stopped = false

  function emit(eventType: ProgressEvent | FailureEvent) {
    if (stopped || sent.has(eventType)) return
    try {
      const errorCode = eventType in ERROR_CODES ? ERROR_CODES[eventType as FailureEvent] : undefined
      log(eventType, errorCode ? { error_code: errorCode } : undefined)
      // Applications and services have separate remote identities. A browser app wins
      // when service is also configured for other SDK features.
      const identity = bounded(configuration.applicationId, 128)
        ? { application_id: configuration.applicationId }
        : bounded(configuration.service, 200)
          ? { service_id: configuration.service }
          : undefined
      if (!identity || !bounded(configuration.env, 200)) {
        sent.add(eventType)
        log(
          'Remote lifecycle diagnostics require an applicationId or service and an env. Local diagnostics remain available.'
        )
        return
      }
      const event = {
        schema_version: 1,
        event_family: 'sdk_diagnostic',
        payload: {
          event_type: eventType,
          timestamp: Date.now(),
          runtime_id: runtimeId,
          sdk_name: 'dd-openfeature-browser',
          sdk_version: __BUILD_ENV__SDK_VERSION__,
          ...identity,
          environment: configuration.env,
          ...(errorCode && { error_code: errorCode }),
        },
      }
      // Bound UTF-8 bytes independently of the transport's much larger generic message limit.
      if (new Blob([JSON.stringify(event)]).size > 2048) {
        log('Lifecycle event exceeds the diagnostic size limit.')
        return
      }
      sent.add(eventType)
      batch.add(event)
    } catch {
      log('Unable to queue lifecycle diagnostics. Flag evaluation is unaffected.')
    }
  }

  return {
    emit,
    stop() {
      if (stopped) return
      stopped = true
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
