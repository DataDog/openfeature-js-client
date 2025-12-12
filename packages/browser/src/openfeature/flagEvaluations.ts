import type { Context, RawError } from '@datadog/browser-core'
import {
  addTelemetryDebug,
  createBatch,
  createFlushController,
  createHttpRequest,
  createIdentityEncoder,
  createPageMayExitObservable,
  Observable,
} from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../domain/configuration'

export function createFlagEvaluationTrackingHook(configuration: FlaggingConfiguration): Hook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const flagEvaluationBatch = createBatch({
    encoder: createIdentityEncoder(),
    request: createHttpRequest(
      [configuration.flagEvaluationEndpointBuilder],
      configuration.batchBytesLimit,
      (error: RawError) => {
        addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
      }
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

  const aggregator = new FlagEvaluationAggregator(
    configuration.flagEvaluationTrackingInterval,
    (events: FlagEvaluationEvent[]) => {
      events.forEach((event) => {
        try {
          const url = window?.location?.href
          const eventWithMetadata: FlagEvaluationEvent = {
            ...event,
            context: {
              ...event.context,
              dd: {
                ...(configuration.service && { service: configuration.service }),
                rum: {
                  ...(configuration.applicationId && { application: { id: configuration.applicationId } }),
                  ...(url && { view: { url } }),
                },
              },
            },
          }
          flagEvaluationBatch.add(eventWithMetadata as unknown as Context)
        } catch (error) {
          addTelemetryDebug('Error adding flag evaluation to batch', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
  )

  aggregator.start()

  pageMayExitObservable.subscribe(() => {
    aggregator.stop()
  })

  return {
    after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      try {
        aggregator.addEvaluation(hookContext.context, details)
      } catch (error) {
        addTelemetryDebug('Error adding evaluation to aggregator', {
          'error.message': error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
