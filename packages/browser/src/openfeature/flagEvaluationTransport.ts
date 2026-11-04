import {
  addTelemetryDebug,
  createPageMayExitObservable,
  Observable,
} from '@datadog/browser-core'
import { NO_DEBUG } from '../debug'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { createTrackedBatch } from '../transport/debugBatch'

export type FlagEvaluationTransport = ReturnType<typeof createFlagEvaluationTransport>

export function createFlagEvaluationTransport(configuration: FlaggingTrackingConfiguration) {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const sessionExpireObservable = new Observable<void>()
  const debug = configuration.debug?.child({ channel: 'evaluation' }) ?? NO_DEBUG
  const batch = createTrackedBatch(
    configuration.flagEvaluationEndpointBuilder,
    (error) => {
      debug.event('upload.error', () => ({ error }))
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    },
    pageMayExitObservable,
    sessionExpireObservable,
    debug
  )
  return {
    batch,
    pageMayExitObservable,
    stop() {
      try {
        sessionExpireObservable.notify()
      } finally {
        batch.stop()
      }
    },
  }
}
