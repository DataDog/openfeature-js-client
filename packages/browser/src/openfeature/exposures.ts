import type { Context, RawError } from '@datadog/browser-core'
import { addTelemetryDebug, createPageMayExitObservable } from '@datadog/browser-core'
import {
  type AssignmentCache,
  completeExposureDecision,
  createExposureEvent,
  type ExposureEvent,
  type ExposureEventWithTimestamp,
  featuresWithPrefix,
  getPrecomputedDependencyEvaluations,
  METADATA_EXPOSURE_FEATURE_PREFIX,
  prepareExposureDecision,
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
import { supportsExposureAdmission } from './exposure-scope'
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
      if (!supportsExposureAdmission(hookContext)) return
      const context = getEvaluationTrackingContext(details, () => getEvaluationContext(hookContext.context))
      const evaluations = [
        ...getPrecomputedDependencyEvaluations(details).filter((dependency) => dependency.isPresentInAssignment),
        details,
      ]
      try {
        const timestamp = timeStampNow()
        const url = window?.location?.href
        for (const evaluation of evaluations) {
          const exposureDetails = evaluation as EvaluationDetails<FlagValue>
          // Complete the provider decision before either destination consumes it.
          const sharedDecision = completeExposureDecision(exposureDetails)
          const exposureEvent = createExposureEvent(context, exposureDetails)
          if (!exposureEvent) continue
          // Dependency exposures belong to the same immutable configuration
          // snapshot as the root result.
          const exposureCacheEntry = getExposureCacheEntry(exposureEvent, details)
          const isRoot = evaluation === details
          const stampedVerdict = exposureDetails.flagMetadata?.__dd_exposure_cache_hit
          const hasLoggedAssignment =
            stampedVerdict === undefined ? exposureCache.has(exposureCacheEntry) : stampedVerdict
          if (hasLoggedAssignment) continue

          if (exposuresBatch) {
            // Features stay off the cache entry: a features change must not turn a
            // repeat exposure into a new one. Dependency feature data is not part
            // of the root precomputed result, so only the root event carries it.
            const features = isRoot
              ? featuresWithPrefix(details.flagMetadata, METADATA_EXPOSURE_FEATURE_PREFIX)
              : undefined
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
          // A shared root decision already recorded the root assignment. Other
          // entries are recorded only after batch.add() succeeds, or immediately
          // in record-only mode where there is no batch.
          if (!sharedDecision) exposureCache.set(exposureCacheEntry)
        }
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
 * Prepares the exposure-cache verdict before OpenFeature freezes metadata.
 * The private decision is finalized once the evaluation completes successfully,
 * shared by the Datadog path and the customer hook.
 */
export function stampExposureCacheVerdict(
  details: ResolutionDetails<FlagValue> & { flagKey: string },
  fallbackContext: EvaluationContext,
  exposureCache: AssignmentCache | undefined
): void {
  const metadata = details.flagMetadata
  if (!metadata || details.errorCode || details.reason === 'ERROR' || details.variant == null) {
    return
  }
  const detailsWithMetadata: EvaluationDetails<FlagValue> = { ...details, flagMetadata: metadata }
  const context = getEvaluationTrackingContext(detailsWithMetadata, () => fallbackContext)
  if (exposureCache) {
    for (const dependency of getPrecomputedDependencyEvaluations(detailsWithMetadata)) {
      if (dependency.isPresentInAssignment) {
        prepareEvaluationExposureDecision(
          dependency as EvaluationDetails<FlagValue>,
          context,
          detailsWithMetadata,
          exposureCache
        )
      }
    }
    prepareEvaluationExposureDecision(detailsWithMetadata, context, detailsWithMetadata, exposureCache)
  }
}

function prepareEvaluationExposureDecision(
  evaluation: EvaluationDetails<FlagValue>,
  context: EvaluationContext,
  rootDetails: EvaluationDetails<FlagValue>,
  exposureCache: AssignmentCache
): void {
  const metadata = evaluation.flagMetadata
  if (
    metadata?.__dd_do_log !== true ||
    evaluation.errorCode ||
    evaluation.reason === 'ERROR' ||
    evaluation.variant == null
  ) {
    return
  }
  const exposureEvent = createExposureEvent(context, evaluation)
  if (exposureEvent) {
    prepareExposureDecision(metadata, exposureCache, getExposureCacheEntry(exposureEvent, rootDetails))
  }
}
