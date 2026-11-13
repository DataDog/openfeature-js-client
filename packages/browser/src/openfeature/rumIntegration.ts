import { type Context, getGlobalObject } from '@datadog/browser-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'
import { createDebugLogger, type DebugConfiguration, type DebugLogger, evaluationDebug, NO_DEBUG } from '../debug'
import { type EvaluationTelemetryPolicy, withEvaluationTelemetryPolicy } from './evaluation-telemetry-policy'
import type { DatadogTrackingHook } from './tracking'

export interface DDRum {
  // biome-ignore lint/suspicious/noExplicitAny: DD RUM interface
  addFeatureFlagEvaluation: (flagKey: string, value: any) => void
  getUser?: () => Context
}

export function enrichEvaluationContextWithRumUser(
  context: EvaluationContext,
  debug: DebugLogger = NO_DEBUG
): EvaluationContext {
  try {
    const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
    const user = globalObject.DD_RUM?.getUser?.()
    if (!user) {
      debug.event('context.rum_enrichment', () => ({ available: false, context, action: 'use_application_context' }))
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

    debug.event('context.rum_enrichment', () => ({
      user,
      accepted: rumUserContext,
      applicationContext: context,
      precedence: 'application',
      refresh: 'on_context_update',
    }))
    return {
      ...rumUserContext,
      // RUM provides defaults; context explicitly supplied through OpenFeature remains authoritative.
      ...context,
    }
  } catch (error) {
    debug.event('context.rum_enrichment_failed', () => ({ error, action: 'use_application_context' }))
    return context
  }
}

export function createRumTrackingHook(policy?: EvaluationTelemetryPolicy, debug: DebugLogger = NO_DEBUG): Hook {
  return withEvaluationTelemetryPolicy(
    {
      finally: (_hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        const evaluation = evaluationDebug(_hookContext.context, debug)
        if (details.errorCode || details.reason === 'ERROR' || details.variant == null) {
          evaluation.event('rum.annotation', () => ({
            details,
            outcome: 'skipped',
            reason: 'evaluation_error_or_no_variant',
          }))
          return
        }
        const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
        try {
          globalObject.DD_RUM?.addFeatureFlagEvaluation?.(details.flagKey, details.variant)
          evaluation.event('rum.annotation', () => ({
            flagKey: details.flagKey,
            value: details.variant,
            outcome: globalObject.DD_RUM?.addFeatureFlagEvaluation ? 'handed_to_rum' : 'rum_unavailable',
            downstreamDelivery: 'not_observable',
          }))
        } catch (error) {
          evaluation.event('rum.annotation_failed', () => ({ details, error }))
          throw error
        }
      },
    },
    policy,
    debug
  )
}

export function createDatadogRumTrackingHook(options: DebugConfiguration = {}): DatadogTrackingHook {
  return {
    hooks: [createRumTrackingHook(undefined, createDebugLogger(options.debugMode, 'rum'))],
  }
}
