import type { Context, PageMayExitEvent, RawError } from '@datadog/browser-core'
import {
  createIdentityEncoder,
  Observable,
  startBatchWithReplica,
} from '@datadog/browser-core'
import type { FlaggingConfiguration } from '../domain/configuration'

export function startExposuresBatch(
  configuration: FlaggingConfiguration,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>,
) {
  const batch = startBatchWithReplica(
    configuration,
    {
      endpoint: configuration.exposuresEndpointBuilder,
      encoder: createIdentityEncoder(),
    },
    // No replica for now
    undefined,
    reportError,
    pageMayExitObservable,
    // We don't track sessions, so no session expiration for now
    new Observable(),
  )

  return batch
}
