import type { PageMayExitEvent, RawError } from '@datadog/browser-core'
import {
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  Observable,
} from '@datadog/browser-core'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'

export function startExposuresBatch(
  configuration: FlaggingTrackingConfiguration,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>
) {
  const sessionExpireObservable = new Observable<void>()
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.exposuresEndpointBuilder], reportError),
    flushController: createFlushController({
      pageMayExitObservable,
      sessionExpireObservable,
    }),
  })

  return {
    ...batch,
    stop: () => {
      // Flush pending exposures and cancel the batch timeout before removing subscriptions.
      try {
        sessionExpireObservable.notify()
      } finally {
        batch.stop()
      }
    },
  }
}
