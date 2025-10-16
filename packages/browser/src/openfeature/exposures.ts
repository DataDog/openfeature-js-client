import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable, dateNow } from '@datadog/browser-core'
import { createExposureEvent, type AssignmentCache, type ExposureEventWithTimestamp } from '@datadog/flagging-core'
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import type { FlaggingConfiguration } from '../domain/configuration'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import type { DDRum } from './rumIntegration'

/**
 * Create hook for RUM flag tracking
 * @deprecated
 */
export function createRumTrackingHook(rum: DDRum): Hook {
  return {
    after: (_hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      rum.addFeatureFlagEvaluation(details.flagKey, details.value)
    },
  }
}

/**
 * Create hook for RUM exposure logging
 * @deprecated
 */
export function createRumExposureHook(rum: DDRum): Hook {
  return {
    after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      rum.addAction('__dd_exposure', {
        timestamp: dateNow(),
        flag_key: details.flagKey,
        allocation_key: (details.flagMetadata?.allocationKey as string) ?? '',
        exposure_key: `${details.flagKey}-${details.flagMetadata?.allocationKey}`,
        subject_key: hookContext.context.targetingKey,
        subject_attributes: hookContext.context,
        variant_key: details.variant,
      })
    },
  }
}

/**
 * Create hook for exposure logging.
 */
export function createExposureLoggingHook(configuration: FlaggingConfiguration, exposureCache: AssignmentCache): Hook {
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
      const timestamp = dateNow()
      const exposureEvent = createExposureEvent(hookContext.context, details)
      if (!exposureEvent) {
        return
      }

      const hasLoggedAssignment = exposureCache.has(exposureEvent)
      if (hasLoggedAssignment) {
        return
      }

      try {
        const exposureEventWithTimestamp: ExposureEventWithTimestamp = {
          ...exposureEvent,
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
