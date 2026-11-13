import { type Context, getGlobalObject } from '@datadog/browser-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import { type EvaluationTelemetryPolicy, withEvaluationTelemetryPolicy } from './evaluation-telemetry-policy'
import { getPrecomputedDependencyEvaluations } from './precomputed-dependencies'
import type { DatadogTrackingHook } from './tracking'

export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
  getUser?: () => Context
}

export function enrichEvaluationContextWithRumUser(context: EvaluationContext): EvaluationContext {
  try {
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    const user = globalObject.DD_RUM?.getUser?.()
    if (!user) {
      return context
    }

    const { id, ...attributes } = user
    const rumUserContext: EvaluationContext = {}

    if (typeof id === 'string') {
      rumUserContext.targetingKey = id
    }

    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        rumUserContext[key] = value
      }
    }

    return {
      ...rumUserContext,
      // RUM provides defaults; context explicitly supplied through OpenFeature remains authoritative.
      ...context,
    }
  } catch {
    return context
  }
}

export function createRumTrackingHook(policy?: EvaluationTelemetryPolicy): Hook {
  return withEvaluationTelemetryPolicy(
    {
      finally: (_hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        if (details.errorCode || details.reason === 'ERROR' || details.variant == null) {
          return
        }
        const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
        const record = (flagKey: string, variant: string) => {
          try {
            globalObject.DD_RUM?.addFeatureFlagEvaluation?.(flagKey, variant)
          } catch {
            // One RUM failure must not suppress the remaining dependency graph.
          }
        }
        for (const dependency of getPrecomputedDependencyEvaluations(details)) {
          if (dependency.isPresentInAssignment && dependency.variant != null) {
            record(dependency.flagKey, dependency.variant)
          }
        }
        record(details.flagKey, details.variant)
      },
    },
    policy
  )
}

export function createDatadogRumTrackingHook(): DatadogTrackingHook {
  return {
    hooks: [createRumTrackingHook()],
  }
}
