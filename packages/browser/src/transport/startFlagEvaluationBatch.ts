import type { PageMayExitEvent, RawError } from '@datadog/browser-core'
import {
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  Observable,
  Duration,
} from '@datadog/browser-core'
import type { FlaggingConfiguration } from '../domain/configuration'

export function startFlagEvaluationBatch(
  configuration: FlaggingConfiguration,
  reportError: (error: RawError) => void,
  pageMayExitObservable: Observable<PageMayExitEvent>
) {
  const batch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest(
      [configuration.flagEvaluationEndpointBuilder],
      configuration.batchBytesLimit,
      reportError
    ),
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
