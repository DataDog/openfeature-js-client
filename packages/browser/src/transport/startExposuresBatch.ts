import type { PageMayExitEvent, RawError } from '@datadog/browser-core'
import {
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  Observable,
} from '@datadog/browser-core'
import type { FlaggingConfiguration } from '../domain/configuration'

export function startExposuresBatch(
  configuration: FlaggingConfiguration,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>
) {
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest([configuration.exposuresEndpointBuilder], configuration.batchBytesLimit, reportError),
    flushController: createFlushController({
      messagesLimit: configuration.batchMessagesLimit,
      bytesLimit: configuration.batchBytesLimit,
      durationLimit: configuration.flushTimeout,
      pageMayExitObservable,
      sessionExpireObservable: new Observable(),
    }),
    messageBytesLimit: configuration.messageBytesLimit,
  })

  return batch
}
