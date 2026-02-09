import { getGlobalObject } from '@datadog/browser-core'
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'

export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
}

export function createRumTrackingHook(): Hook {
  return {
    after: (_hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
      if (details.variant == null) {
        return
      }
      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM?.addFeatureFlagEvaluation?.(details.flagKey, details.variant)
    },
  }
}
