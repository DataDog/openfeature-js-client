import { dateNow, createPageMayExitObservable, addTelemetryDebug } from '@datadog/browser-core'
import type { RawError } from '@datadog/browser-core'
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import type { ExposureEvent } from '../exposureEvent.types'
import type { DDRum } from './rumIntegration'
import type { FlaggingConfiguration } from '../domain/configuration'

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
export function createExposureLoggingHook(configuration: FlaggingConfiguration): Hook {
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
      // Only log if doLog flag is true
      if (!details.flagMetadata?.doLog) {
        return
      }

      // Skip logging if allocation key or variant is missing (this should never happen)
      const allocationKey = details.flagMetadata?.allocationKey as string
      const variantKey = details.variant
      if (!allocationKey || !variantKey) {
        return
      }

      const exposureEvent = {
        timestamp: new Date().toISOString(),
        allocation: {
          key: allocationKey,
        },
        flag: {
          key: details.flagKey,
        },
        variant: {
          key: variantKey,
        },
        subject: {
          id: hookContext.context.targetingKey || '',
        },
      } satisfies ExposureEvent

      // Add context and send via exposures batch
      exposuresBatch.add(exposureEvent)
    },
  }
}
