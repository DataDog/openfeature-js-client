import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import {
  type AssignmentCache,
  createExposureEvent,
  type ExposureEvent,
  type ExposureEventWithTimestamp,
} from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import { assignmentCacheFactory } from '../cache/assignment-cache-factory'
import { chromeStorageIfAvailable } from '../cache/helpers'
import type { FlaggingTrackingConfiguration } from '../domain/configuration'
import { validateAndBuildFlaggingTrackingConfiguration } from '../domain/configuration'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import { getOfflineConfigurationId } from './offline-provider-metadata'
import type { DatadogTrackingHook, DatadogTrackingHooksOptions } from './tracking'
import { runTrackingLifecycleOperation } from './tracking'

export interface DatadogExposureLoggingHook extends DatadogTrackingHook {
  initialize(): Promise<void>
}

type ExposureCacheEntry = ExposureEvent & {
  __dd_offline_configuration_id?: string
}

/**
 * Create hook for exposure logging.
 */
export function createExposureLoggingHook(
  configuration: FlaggingTrackingConfiguration,
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
    }
  }

  const exposureCache = assignmentCacheFactory({
    chromeStorage: chromeStorageIfAvailable(),
    storageKeySuffix: 'dd-of-browser',
  })

  return {
    hooks: [createExposureLoggingHook(configuration, exposureCache)],
    initialize: () => runTrackingLifecycleOperation(() => exposureCache.init()),
  }
}

function getExposureCacheEntry(
  exposureEvent: ExposureEvent,
  details: EvaluationDetails<FlagValue>
): ExposureCacheEntry {
  const offlineConfigurationId = getOfflineConfigurationId(details)
  return offlineConfigurationId === undefined
    ? exposureEvent
    : {
        ...exposureEvent,
        __dd_offline_configuration_id: offlineConfigurationId,
      }
}
