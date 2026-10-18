import type { EvaluationContext, Hook, HookContext, ProviderMetadata } from '@openfeature/web-sdk'
import type { EvaluationTelemetryOptOutConfiguration } from '../domain/configuration'

const attribute = 'dd_evaluation_telemetry_opt_out'

// Metadata identity connects separately composed Datadog hooks to their provider.
// No policy markers enter public evaluation results or customer metadata.
const policies = new WeakMap<ProviderMetadata, EvaluationTelemetryPolicy>()

export interface EvaluationTelemetryPolicy {
  setContext(context: EvaluationContext): void
  allowsTelemetry(context: EvaluationContext): boolean
}

export function createEvaluationTelemetryPolicy(
  metadata: ProviderMetadata,
  configuration: EvaluationTelemetryOptOutConfiguration
): EvaluationTelemetryPolicy {
  const enabled = configuration.enableEvaluationTelemetryOptOutParameter === true
  let currentContext: EvaluationContext = {}
  const policy = {
    setContext(context: EvaluationContext) {
      currentContext = { ...context }
    },
    allowsTelemetry(context: EvaluationContext) {
      return !enabled || !(isOptedOut(context) || isOptedOut(currentContext))
    },
  }
  policies.set(metadata, policy)
  return policy
}

export function inheritEvaluationTelemetryPolicy(metadata: ProviderMetadata, innerMetadata: ProviderMetadata): void {
  const policy = policies.get(innerMetadata)
  if (policy) policies.set(metadata, policy)
}

export function withEvaluationTelemetryPolicy<T extends Hook>(hook: T): T {
  const admissions = new WeakMap<HookContext, boolean>()
  const allowsTelemetry = (context: HookContext) =>
    policies.get(context.providerMetadata)?.allowsTelemetry(context.context) ?? true
  return {
    ...hook,
    before: (context, hints) => {
      admissions.set(context, allowsTelemetry(context))
      return hook.before?.(context, hints)
    },
    finally: (context, details, hints) => {
      const allowedAtStart = admissions.get(context) !== false
      admissions.delete(context)
      // A customer hook can change consent during evaluation. Do not restore admission mid-call.
      if (allowedAtStart && allowsTelemetry(context)) return hook.finally?.(context, details, hints)
    },
  }
}

function isOptedOut(context: EvaluationContext): boolean {
  // Use hasOwnProperty for the supported ES2018 runtime target.
  return Object.prototype.hasOwnProperty.call(context, attribute) && context[attribute] === true
}
