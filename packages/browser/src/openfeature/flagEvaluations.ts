import type { Context } from '@datadog/browser-core'
import { addTelemetryDebug, createBatch } from '@datadog/browser-core'
import { FlagEvaluationAggregator, type FlagEvaluationEvent } from '@datadog/flagging-core'
import { createEndpointBuilder } from '@datadog/js-core/transport'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../domain/configuration'

export function createFlagEvalEVPHook(
  configuration: FlaggingConfiguration,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context
): Hook & { stop: () => void } {
  const flagEvaluationBatch = createBatch({
    endpoints: [createEndpointBuilder(configuration, 'flagevaluation')],
    reportError: (message) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': message })
    },
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

  const urgentFlushSubscription = flagEvaluationBatch.prepareUrgentFlushObservable.subscribe(() => {
    aggregator.stop()
  })
  let stopped = false

  return {
    after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      if (stopped) {
        return
      }
      try {
        aggregator.addEvaluation(getEvaluationContext(hookContext.context), details)
      } catch (error) {
        addTelemetryDebug('Error adding evaluation to aggregator', {
          'error.message': error instanceof Error ? error.message : String(error),
        })
      }
    },
    stop: () => {
      if (stopped) {
        return
      }
      stopped = true
      for (const cleanup of [
        () => aggregator.stop(),
        () => flagEvaluationBatch.forceFlush('duration_limit'),
        () => flagEvaluationBatch.stop(),
        () => urgentFlushSubscription.unsubscribe(),
      ]) {
        try {
          cleanup()
        } catch (error) {
          addTelemetryDebug('Error stopping flag evaluation tracking', {
            'error.message': error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}
