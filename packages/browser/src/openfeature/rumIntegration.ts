import { type Context, getGlobalObject } from '@datadog/browser-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'

export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
  getUser?: () => Context
}

/**
 * Explicitly add the current RUM user to an OpenFeature evaluation context.
 *
 * The helper reads the RUM user each time it is called and returns a new context; it does not keep
 * the OpenFeature context synchronized when the RUM user changes. The RUM user ID supplies the
 * targeting key, while flat primitive user properties supply attributes. Application fields take
 * precedence, and an explicitly undefined application field removes the corresponding RUM value
 * from the returned context.
 */
export function enrichRumContext(context: EvaluationContext): EvaluationContext {
  const effectiveContext = new Map(getRumContextEntries())

  try {
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) {
        effectiveContext.delete(key)
      } else {
        effectiveContext.set(key, value)
      }
    }

    const enrichedContext: Record<string, unknown> = {}
    for (const [key, value] of effectiveContext) {
      enrichedContext[key] = value
    }
    return enrichedContext as EvaluationContext
  } catch {
    return context
  }
}

function getRumContextEntries(): Array<[string, unknown]> {
  try {
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    const user = globalObject.DD_RUM?.getUser?.()
    if (!user) {
      return []
    }

    const entries: Array<[string, unknown]> = []

    for (const [key, value] of Object.entries(user)) {
      if (key !== 'id' && isSupportedAttribute(value)) {
        entries.push([key, value])
      }
    }

    if (typeof user.id === 'string') {
      entries.push(['targetingKey', user.id])
    }

    return entries
  } catch {
    return []
  }
}

function isSupportedAttribute(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
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
