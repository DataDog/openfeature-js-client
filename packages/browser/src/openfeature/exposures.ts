import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import { type AssignmentCache, createExposureEvent, type ExposureEventWithTimestamp } from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../domain/configuration'
import { startExposuresBatch } from '../transport/startExposuresBatch'

/**
 * Create hook for exposure logging.
 */
export function createExposureLoggingHook(
  configuration: FlaggingConfiguration,
  exposureCache: AssignmentCache,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context
): Hook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const exposuresBatch = startExposuresBatch(
    configuration,
    (error: RawError) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    },
    pageMayExitObservable
  )

  return {
    after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      const timestamp = timeStampNow()
      const evaluationContext = getEvaluationContext(hookContext.context)
      const exposureEvent = createExposureEvent(evaluationContext, details)
      if (!exposureEvent) {
        return
      }

      const hasLoggedAssignment = exposureCache.has(exposureEvent)
      if (hasLoggedAssignment) {
        return
      }

      try {
        const url = window?.location?.href
        const exposureEventWithTimestamp: ExposureEventWithTimestamp = {
          ...exposureEvent,
          ...(configuration.service ? { service: configuration.service } : {}),
          rum: {
            ...(configuration.applicationId && { application: { id: configuration.applicationId } }),
            ...(url && { view: { url } }),
          },
          timestamp,
        }
        exposuresBatch.add(exposureEventWithTimestamp as unknown as Context)
        // Only cache if batch.add() succeeds
        exposureCache.set(exposureEvent)
      } catch (error) {
        addTelemetryDebug('Error adding exposure to batch', {
          'error.message': error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
