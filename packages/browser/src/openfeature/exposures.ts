import { dateNow, createPageMayExitObservable, addTelemetryDebug } from '@datadog/browser-core'
import type { RawError } from '@datadog/browser-core'
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import type { ExposureEvent } from '../exposureEvent.types'
import type { FlaggingConfiguration } from '../domain/configuration'

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
        timestamp: dateNow(),
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
