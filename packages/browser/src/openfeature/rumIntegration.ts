import type { Context } from '@datadog/browser-core'
import { globalObject } from '@datadog/js-core/util'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'

export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
  getUser?: () => Context
}

export function enrichEvaluationContextWithRumUser(context: EvaluationContext): EvaluationContext {
  try {
    const user = (globalObject as typeof globalThis & { DD_RUM?: DDRum }).DD_RUM?.getUser?.()
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

export function createRumTrackingHook(): Hook {
  return {
    after: (_hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      if (details.variant == null) {
        return
      }
      ;(globalObject as typeof globalThis & { DD_RUM?: DDRum }).DD_RUM?.addFeatureFlagEvaluation?.(
        details.flagKey,
        details.variant
      )
    },
  }
}
