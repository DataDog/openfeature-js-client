import type { PageMayExitEvent, RawError } from '@datadog/browser-core'
import { Observable } from '@datadog/browser-core'
import { NO_DEBUG } from '../debug'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { createTrackedBatch } from './debugBatch'

export function startExposuresBatch(
  configuration: FlaggingTrackingConfiguration,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>
) {
  const sessionExpireObservable = new Observable<void>()
  const batch = createTrackedBatch(
    configuration.exposuresEndpointBuilder,
    reportError,
    pageMayExitObservable,
    sessionExpireObservable,
    configuration.debug?.child({ channel: 'exposure' }) ?? NO_DEBUG
  )

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
