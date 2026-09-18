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
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.exposuresEndpointBuilder], reportError),
    flushController: createFlushController({
      pageMayExitObservable,
      sessionExpireObservable: new Observable(),
    }),
  })

  return batch
}
