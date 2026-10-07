import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import {
  type AssignmentCache,
  createExposureEvent,
  type ExposureEvent,
  type ExposureEventWithTimestamp,
} from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext, EvaluationDetails, FlagValue, HookContext } from '@openfeature/web-sdk'
import { createExposureCache } from '../cache/exposure-cache'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import { getCoreConfigurationId } from './core-provider-metadata'
import type { DatadogTrackingHook, DatadogTrackingHooksOptions, ManagedTrackingHook } from './tracking'
import { createTrackingHookController, runTrackingLifecycleOperation } from './tracking'

export interface DatadogExposureLoggingHook extends DatadogTrackingHook {
  initialize(): Promise<void>
  shutdown(): Promise<void>
}

type ExposureCacheEntry = ExposureEvent & {
  __dd_core_configuration_id?: string
}

/**
 * Create hook for exposure logging.
 */
export function createExposureLoggingHook(
  configuration: FlaggingTrackingConfiguration,
  exposureCache: AssignmentCache,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context
): ManagedTrackingHook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const exposuresBatch = startExposuresBatch(
    configuration,
    (error: RawError) => {
      addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
    },
    pageMayExitObservable
  )

  return {
    shutdown: () => exposuresBatch.stop(),
    after: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      const timestamp = timeStampNow()
      const exposureEvent = createExposureEvent(getEvaluationContext(hookContext.context), details)
      if (!exposureEvent) {
        return
      }
      const exposureCacheEntry = getExposureCacheEntry(exposureEvent, details)

      const hasLoggedAssignment = exposureCache.has(exposureCacheEntry)
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
        exposureCache.set(exposureCacheEntry)
      } catch (error) {
        addTelemetryDebug('Error adding exposure to batch', {
          'error.message': error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export function createDatadogExposureLoggingHook(options: DatadogTrackingHooksOptions): DatadogExposureLoggingHook {
  const configuration = validateAndBuildFlaggingTrackingConfiguration(options)
  if (!configuration) {
    return {
      hooks: [],
      initialize: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
  }

  const exposureCache = createExposureCache(options, configuration)

  return createTrackingHookController(async () => {
    await runTrackingLifecycleOperation(() => exposureCache.init())
    return createExposureLoggingHook(configuration, exposureCache)
  })
}

function getExposureCacheEntry(
  exposureEvent: ExposureEvent,
  details: EvaluationDetails<FlagValue>
): ExposureCacheEntry {
  const coreConfigurationId = getCoreConfigurationId(details)
  return coreConfigurationId === undefined
    ? exposureEvent
    : {
        ...exposureEvent,
        __dd_core_configuration_id: coreConfigurationId,
      }
}
