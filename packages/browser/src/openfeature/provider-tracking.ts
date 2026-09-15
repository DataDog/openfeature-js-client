import type { AssignmentCache } from '@datadog/flagging-core'
import type { EvaluationContext, Hook, HookContext } from '@openfeature/web-sdk'
import { assignmentCacheFactory } from '../cache/assignment-cache-factory'
import { chromeStorageIfAvailable } from '../cache/helpers'
import { ResettableAssignmentCache } from '../cache/resettable-assignment-cache'
import type { FlaggingTrackingConfiguration, FlaggingTrackingInitConfiguration } from '../domain/configuration'
import { createExposureLoggingHook } from './exposures'
import { createFlagEvalEVPHook } from './flagEvaluations'
import { createRumTrackingHook } from './rumIntegration'

export interface ProviderTracking {
  hooks: Hook[]
  exposureCache?: AssignmentCache
}

export function createProviderTracking({
  options,
  configuration,
  enabledByDefault,
  getTrackingContext,
  serializeExposureCacheLifecycle = false,
}: {
  options: Partial<FlaggingTrackingInitConfiguration>
  configuration?: FlaggingTrackingConfiguration
  enabledByDefault: boolean
  getTrackingContext?: (context: EvaluationContext) => EvaluationContext
  serializeExposureCacheLifecycle?: boolean
}): ProviderTracking {
  const hooks: Hook[] = []

  if (options.enableRumFeatureFlagTracking ?? enabledByDefault) {
    hooks.push(createRumTrackingHook())
  }

  if ((options.enableFlagEvaluationTracking ?? enabledByDefault) && configuration) {
    hooks.push(createFlagEvalEVPHook(configuration))
  }

  let exposureCache: AssignmentCache | undefined
  if ((options.enableExposureLogging ?? enabledByDefault) && configuration) {
    exposureCache = assignmentCacheFactory({
      chromeStorage: chromeStorageIfAvailable(),
      storageKeySuffix: 'dd-of-browser',
    })
    if (serializeExposureCacheLifecycle) {
      exposureCache = new ResettableAssignmentCache(exposureCache)
    }
    hooks.push(createExposureLoggingHook(configuration, exposureCache))
  }

  return {
    hooks: getTrackingContext ? hooks.map((hook) => withTrackingContext(hook, getTrackingContext)) : hooks,
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
