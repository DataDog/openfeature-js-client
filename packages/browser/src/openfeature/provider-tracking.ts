import type { AssignmentCache } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { createExposureCache } from '../cache/exposure-cache'
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
}: {
  options: Partial<FlaggingTrackingInitConfiguration>
  configuration?: FlaggingTrackingConfiguration
  enabledByDefault: boolean
  getTrackingContext?: (context: EvaluationContext) => EvaluationContext
  getTransport?: () => FlagEvaluationTransport | undefined
  telemetryPolicy?: EvaluationTelemetryPolicy
}): ProviderTracking {
  const trackingHooks: DatadogTrackingHook[] = []

  if (options.enableRumFeatureFlagTracking ?? enabledByDefault) {
    trackingHooks.push({ hooks: [createRumTrackingHook(telemetryPolicy)] })
  }

  if ((options.enableFlagEvaluationTracking ?? enabledByDefault) && configuration) {
    trackingHooks.push(
      createTrackingHookController(() =>
        createFlagEvalEVPHook(configuration, getTrackingContext, telemetryPolicy, getTransport?.())
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
      createTrackingHookController(async () => {
        await runTrackingLifecycleOperation(() => cache.init())
        return createExposureLoggingHook(configuration, cache, getTrackingContext, { sendToDatadog })
      })
    )
  }

  const tracking = composeDatadogTrackingHooks(...trackingHooks)
  return {
    ...tracking,
    exposureCache,
  }
}
