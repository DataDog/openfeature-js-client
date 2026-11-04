import {
  addTelemetryDebug,
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  createPageMayExitObservable,
  Observable,
} from '@datadog/browser-core'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'

export type FlagEvaluationTransport = ReturnType<typeof createFlagEvaluationTransport>

export function createFlagEvaluationTransport(configuration: FlaggingTrackingConfiguration) {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const sessionExpireObservable = new Observable<void>()
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.flagEvaluationEndpointBuilder], (error) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    }),
    flushController: createFlushController({ pageMayExitObservable, sessionExpireObservable }),
  })
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
