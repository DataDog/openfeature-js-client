import type { AssignmentCache } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { createExposureCache } from '../cache/exposure-cache'
import { type DebugLogger, NO_DEBUG } from '../debug'
import {
  type FlaggingTrackingConfiguration,
  type FlaggingTrackingInitConfiguration,
  resolveTrackExposures,
} from '../domain/configuration'
import type { EvaluationTelemetryPolicy } from './evaluation-telemetry-policy'
import { createExposureLoggingHook } from './exposures'
import { createFlagEvalEVPHook } from './flagEvaluations'
import type { FlagEvaluationTransport } from './flagEvaluationTransport'
import { createRumTrackingHook } from './rumIntegration'
import type { DatadogTrackingHook, DatadogTrackingHooks } from './tracking'
import { composeDatadogTrackingHooks, createTrackingHookController, runTrackingLifecycleOperation } from './tracking'

export interface ProviderTracking extends DatadogTrackingHooks {
  exposureCache?: AssignmentCache
}

export function createProviderTracking({
  options,
  configuration,
  enabledByDefault,
  getTrackingContext,
  getTransport,
  telemetryPolicy,
  debug = configuration?.debug ?? NO_DEBUG,
}: {
  options: Partial<FlaggingTrackingInitConfiguration>
  configuration?: FlaggingTrackingConfiguration
  enabledByDefault: boolean
  getTrackingContext?: (context: EvaluationContext) => EvaluationContext
  getTransport?: () => FlagEvaluationTransport | undefined
  telemetryPolicy?: EvaluationTelemetryPolicy
  debug?: DebugLogger
}): ProviderTracking {
  const trackingHooks: DatadogTrackingHook[] = []
  debug.event('tracking.configured', () => ({
    exposure: options.trackExposures ?? options.enableExposureLogging ?? enabledByDefault,
    evaluation: options.enableFlagEvaluationTracking ?? enabledByDefault,
    rum: options.enableRumFeatureFlagTracking ?? enabledByDefault,
    validConfiguration: !!configuration,
    flagConfigurationCustomFetchAppliesToTracking: false,
  }))

  if (options.enableRumFeatureFlagTracking ?? enabledByDefault) {
    trackingHooks.push({ hooks: [createRumTrackingHook(telemetryPolicy, debug.child({ channel: 'rum' }))] })
  }

  if ((options.enableFlagEvaluationTracking ?? enabledByDefault) && configuration) {
    trackingHooks.push(
      createTrackingHookController(
        () => createFlagEvalEVPHook(configuration, getTrackingContext, telemetryPolicy, getTransport?.()),
        debug.child({ channel: 'evaluation' })
      )
    )
  }

  // The exposure cache and its recording hook exist whenever tracking is
  // configured: turning exposure logging off must not break deduplication for
  // customers recording exposures in their own data store. The toggle only
  // stops the batch send to Datadog.
  let exposureCache: AssignmentCache | undefined
  if (configuration) {
    const cache = createExposureCache(options, configuration)
    exposureCache = cache
    const sendToDatadog = resolveTrackExposures(options, enabledByDefault)
    trackingHooks.push(
      createTrackingHookController(
        async () => {
          await runTrackingLifecycleOperation(() => cache.init(), debug)
          return createExposureLoggingHook(configuration, cache, getTrackingContext, { sendToDatadog })
        },
        debug.child({ channel: 'exposure' })
      )
    )
  }

  if (debug.enabled)
    trackingHooks.push({
      hooks: [
        {
          before: (context) => debug.event('evaluation.requested', () => ({ context })),
          finally: (context, details) => debug.event('evaluation.returned', () => ({ context, details })),
        },
      ],
    })
  const tracking = composeDatadogTrackingHooks(...trackingHooks)
  return {
    ...tracking,
    exposureCache,
  }
}
