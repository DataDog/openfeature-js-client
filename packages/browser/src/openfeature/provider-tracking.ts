import type { AssignmentCache } from '@datadog/flagging-core'
import type { EvaluationContext, Hook, HookContext } from '@openfeature/web-sdk'
import { createExposureCache } from '../cache/exposure-cache'
import type { FlaggingTrackingConfiguration, FlaggingTrackingInitConfiguration } from '../domain/configuration'
import { createExposureLoggingHook } from './exposures'
import { createFlagEvalEVPHook } from './flagEvaluations'
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
}: {
  options: Partial<FlaggingTrackingInitConfiguration>
  configuration?: FlaggingTrackingConfiguration
  enabledByDefault: boolean
  getTrackingContext?: (context: EvaluationContext) => EvaluationContext
}): ProviderTracking {
  const trackingHooks: DatadogTrackingHook[] = []

  if (options.enableRumFeatureFlagTracking ?? enabledByDefault) {
    trackingHooks.push({ hooks: [createRumTrackingHook()] })
  }

  if ((options.enableFlagEvaluationTracking ?? enabledByDefault) && configuration) {
    trackingHooks.push(createTrackingHookController(() => createFlagEvalEVPHook(configuration)))
  }

  let exposureCache: AssignmentCache | undefined
  if ((options.enableExposureLogging ?? enabledByDefault) && configuration) {
    const cache = createExposureCache(options, configuration)
    exposureCache = cache
    trackingHooks.push(
      createTrackingHookController(async () => {
        await runTrackingLifecycleOperation(() => cache.init())
        return createExposureLoggingHook(configuration, cache)
      })
    )
  }

  const tracking = composeDatadogTrackingHooks(...trackingHooks)
  return {
    ...tracking,
    hooks: getTrackingContext
      ? tracking.hooks.map((hook) => withTrackingContext(hook, getTrackingContext))
      : tracking.hooks,
    exposureCache,
  }
}

function withTrackingContext(hook: Hook, getTrackingContext: (context: EvaluationContext) => EvaluationContext): Hook {
  if (!hook.after) {
    return hook
  }

  return {
    ...hook,
    after: (hookContext, details, hookHints) =>
      hook.after?.(
        {
          ...hookContext,
          context: getTrackingContext(hookContext.context),
        } as HookContext,
        details,
        hookHints
      ),
  }
}
