import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import {
  type AssignmentCache,
  createExposureEvent,
  type ExposureEvent,
  type ExposureEventWithTimestamp,
  featuresWithPrefix,
  METADATA_EXPOSURE_FEATURE_PREFIX,
} from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type {
  EvaluationContext,
  EvaluationDetails,
  FlagValue,
  HookContext,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { createExposureCache } from '../cache/exposure-cache'
import {
  type FlaggingTrackingConfiguration,
  type FlaggingTrackingInitConfiguration,
  resolveTrackExposures,
  validateAndBuildFlaggingTrackingConfiguration,
} from '../domain/configuration'
import { startExposuresBatch } from '../transport/startExposuresBatch'
import { getCoreConfigurationId } from './core-provider-metadata'
import { getEvaluationTrackingContext } from './evaluation-telemetry-policy'
import type { DatadogTrackingHook, ManagedTrackingHook } from './tracking'
import { createTrackingHookController, runTrackingLifecycleOperation } from './tracking'

/**
 * The standalone exposure controller: owns the one exposure cache used by the
 * Datadog send path, the customer exposure hook and any provider wired to it.
 */
export interface DatadogExposureLoggingHook extends DatadogTrackingHook {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  /** Pass to a provider constructor (for example `DatadogCoreProvider`) to share the cache. */
  readonly exposureCache?: AssignmentCache
}

type ExposureCacheEntry = ExposureEvent & {
  __dd_core_configuration_id?: string
}

export interface ExposureLoggingHookOptions {
  /** When false, no exposure event is sent to Datadog; the cache still records. */
  sendToDatadog: boolean
}

/**
 * Create hook for exposure logging.
 */
export function createExposureLoggingHook(
  configuration: FlaggingTrackingConfiguration,
  exposureCache: AssignmentCache,
  getEvaluationContext: (context: EvaluationContext) => EvaluationContext = (context) => context,
  { sendToDatadog }: ExposureLoggingHookOptions = { sendToDatadog: true }
): ManagedTrackingHook {
  const pageMayExitObservable = createPageMayExitObservable(configuration)
  const exposuresBatch = sendToDatadog
    ? startExposuresBatch(
        configuration,
        (error: RawError) => {
          addTelemetryDebug('Error reported to customer', { 'error.message': error.message })
        },
        pageMayExitObservable
      )
    : undefined

  return {
    shutdown: () => exposuresBatch?.stop(),
    finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      if (details.errorCode || details.reason === 'ERROR' || details.variant == null) {
        return
      }
      const exposureEvent = createExposureEvent(
        getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context)),
        details
      )
      if (!exposureEvent) {
        return
      }
      const exposureCacheEntry = getExposureCacheEntry(exposureEvent, details)

      // The provider stamps the verdict at resolve time. Fall back to the cache
      // for results that did not come from this provider's resolver.
      const stampedVerdict = details.flagMetadata?.__dd_exposure_cache_hit
      const hasLoggedAssignment = stampedVerdict === undefined ? exposureCache.has(exposureCacheEntry) : stampedVerdict
      if (hasLoggedAssignment) {
        return
      }

      try {
        if (exposuresBatch) {
          const url = window?.location?.href
          const timestamp = timeStampNow()
          // Features stay off the cache entry: a features change must not turn a
          // repeat exposure into a new one.
          const features = featuresWithPrefix(details.flagMetadata, METADATA_EXPOSURE_FEATURE_PREFIX)
          const exposureEventWithTimestamp: ExposureEventWithTimestamp = {
            ...exposureEvent,
            ...(features && { features }),
            ...(configuration.service ? { service: configuration.service } : {}),
            rum: {
              ...(configuration.applicationId && { application: { id: configuration.applicationId } }),
              ...(url && { view: { url } }),
            },
            timestamp,
          }
          exposuresBatch.add(exposureEventWithTimestamp as unknown as Context)
        }
        exposureCache.set(exposureCacheEntry)
      } catch (error) {
        addTelemetryDebug('Error adding exposure to batch', {
          'error.message': error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export function createDatadogExposureLoggingHook(
  options: FlaggingTrackingInitConfiguration
): DatadogExposureLoggingHook {
  const configuration = validateAndBuildFlaggingTrackingConfiguration(options)
  if (!configuration) {
    return {
      hooks: [],
      initialize: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
    }
  }

  const exposureCache = createExposureCache(options, configuration)
  // `trackExposures` false is record-only mode: nothing is sent to Datadog, but
  // the cache keeps recording so verdicts stay correct.
  const sendToDatadog = resolveTrackExposures(options, true)

  return {
    ...createTrackingHookController(async () => {
      await runTrackingLifecycleOperation(() => exposureCache.init())
      return createExposureLoggingHook(configuration, exposureCache, undefined, { sendToDatadog })
    }),
    exposureCache,
  }
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

/**
 * Stamps the one exposure-cache verdict per evaluation into flag metadata. Called
 * by the provider at resolve time, before the SDK freezes the metadata for hooks.
 */
export function stampExposureCacheVerdict(
  details: ResolutionDetails<FlagValue> & { flagKey: string },
  fallbackContext: EvaluationContext,
  exposureCache: AssignmentCache | undefined
): void {
  const metadata = details.flagMetadata
  if (!metadata || metadata.__dd_do_log !== true || details.errorCode || details.variant == null) {
    return
  }
  const detailsWithMetadata: EvaluationDetails<FlagValue> = { ...details, flagMetadata: metadata }
  const exposureEvent = createExposureEvent(
    getEvaluationTrackingContext(detailsWithMetadata, () => fallbackContext),
    detailsWithMetadata
  )
  if (!exposureEvent) {
    return
  }
  metadata.__dd_exposure_cache_hit =
    exposureCache?.has(getExposureCacheEntry(exposureEvent, detailsWithMetadata)) ?? false
}
