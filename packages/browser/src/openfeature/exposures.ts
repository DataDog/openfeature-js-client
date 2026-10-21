import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import {
  type AssignmentCache,
  createExposureEvent,
  type ExposureEvent,
  type ExposureEventWithTimestamp,
  getPrecomputedDependencyEvaluations,
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
    finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      if (details.errorCode || details.reason === 'ERROR' || details.variant == null) {
        return
      }
      const context = getEvaluationContext(hookContext.context)
      const evaluations = [...getPrecomputedDependencyEvaluations(details), details]
      try {
        const pending: Array<{ exposureEvent: ExposureEvent; exposureCacheEntry: ExposureCacheEntry }> = []
        for (const evaluation of evaluations) {
          const exposureDetails = evaluation as EvaluationDetails<FlagValue>
          const exposureEvent = createExposureEvent(context, exposureDetails)
          if (!exposureEvent) continue
          // Dependency exposures belong to the same immutable configuration
          // snapshot as the root result.
          const exposureCacheEntry = getExposureCacheEntry(exposureEvent, details)
          if (!exposureCache.has(exposureCacheEntry)) pending.push({ exposureEvent, exposureCacheEntry })
        }
        const timestamp = timeStampNow()
        const url = window?.location?.href
        for (const { exposureEvent, exposureCacheEntry } of pending) {
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
          // Only cache if batch.add() succeeds.
          exposureCache.set(exposureCacheEntry)
        }
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
