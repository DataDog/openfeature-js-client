import type {
  EvaluationContext,
  FlagValue,
  Hook,
  HookContext,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import type { EvaluationTelemetryOptOutConfiguration } from '../domain/configuration'

const attribute = 'dd_evaluation_telemetry_opt_out'

// Metadata identity connects separately composed Datadog hooks to their provider.
// No policy markers enter public evaluation results or customer metadata.
const policies = new WeakMap<ProviderMetadata, EvaluationTelemetryPolicy>()
// OpenFeature preserves flagMetadata identity through MultiProvider resolution.
// Keep this association private instead of adding policy fields to customer results.
const resultPolicies = new WeakMap<object, EvaluationTelemetryPolicy>()

export interface EvaluationTelemetryPolicy {
  setContext(context: EvaluationContext): void
  allowsTelemetry(context: EvaluationContext): boolean
}

export function createEvaluationTelemetryPolicy(
  metadata: ProviderMetadata,
  configuration: EvaluationTelemetryOptOutConfiguration,
  getTrackingContext?: () => EvaluationContext
): EvaluationTelemetryPolicy {
  const enabled = configuration.enableEvaluationTelemetryOptOutParameter === true
  let currentContextOptedOut = false
  const subjects = new Map<string | undefined, boolean>()
  const policy = {
    setContext(context: EvaluationContext) {
      currentContextOptedOut =
        enabled && Object.prototype.propertyIsEnumerable.call(context, attribute) && isOptedOut(context)
      if (enabled) {
        subjects.set(context.targetingKey, isOptedOut(context))
        // Superseded fetches cannot install assignments. Retain only the
        // requested subject and the subject whose assignments remain active.
        const activeSubject = getTrackingContext?.().targetingKey
        for (const subject of subjects.keys()) {
          if (subject !== context.targetingKey && subject !== activeSubject) subjects.delete(subject)
        }
      }
    },
    allowsTelemetry(context: EvaluationContext) {
      const tracking = getTrackingContext?.()
      const activeOptedOut = tracking && (subjects.get(tracking.targetingKey) ?? isOptedOut(tracking))
      return !enabled || !(isOptedOut(context) || currentContextOptedOut || activeOptedOut)
    },
  }
  policies.set(metadata, policy)
  return policy
}

export function inheritEvaluationTelemetryPolicy(metadata: ProviderMetadata, innerMetadata: ProviderMetadata): void {
  const policy = policies.get(innerMetadata)
  if (policy) policies.set(metadata, policy)
}

export function bindEvaluationTelemetryResult<T extends FlagValue>(
  result: ResolutionDetails<T>,
  policy: EvaluationTelemetryPolicy
): ResolutionDetails<T> {
  if (result.flagMetadata) resultPolicies.set(result.flagMetadata, policy)
  return result
}

function getPolicies(metadata: ProviderMetadata | undefined, visited = new Set<object>()): EvaluationTelemetryPolicy[] {
  if (!metadata || visited.has(metadata)) return []
  visited.add(metadata)
  const policy = policies.get(metadata)
  if (policy) return [policy]
  // Composite providers expose child metadata under registered names. Do not
  // depend on their constructor name, which can change during bundling.
  const children: EvaluationTelemetryPolicy[] = []
  for (const child of Object.values(metadata)) {
    if (child && typeof child === 'object' && 'name' in child) {
      children.push(...getPolicies(child as ProviderMetadata, visited))
    }
  }
  return children
}

export function withEvaluationTelemetryPolicy<T extends Hook>(hook: T, boundPolicy?: EvaluationTelemetryPolicy): T {
  const admissions = new WeakMap<HookContext, Map<EvaluationTelemetryPolicy, boolean>>()
  return {
    ...hook,
    before: (context, hints) => {
      const candidates = boundPolicy ? [boundPolicy] : getPolicies(context.providerMetadata)
      admissions.set(context, new Map(candidates.map((policy) => [policy, policy.allowsTelemetry(context.context)])))
      return hook.before?.(context, hints)
    },
    finally: (context, details, hints) => {
      const atStart = admissions.get(context)
      admissions.delete(context)
      const selected = boundPolicy ?? resultPolicies.get(details.flagMetadata)
      // Successful Datadog results carry their policy association. Do not apply
      // another child's policy to an unrelated provider result. For aggregate
      // failures without a producer, retain each Datadog child's suppression.
      if (!selected && !policies.has(context.providerMetadata) && !details.errorCode && details.reason !== 'ERROR') {
        return hook.finally?.(context, details, hints)
      }
      const candidates = selected ? [selected] : getPolicies(context.providerMetadata)
      const allowed = candidates.every(
        (policy) => atStart?.get(policy) !== false && policy.allowsTelemetry(context.context)
      )
      // A customer hook can change consent during evaluation. Do not restore admission mid-call.
      if (allowed) return hook.finally?.(context, details, hints)
    },
  }
}

function isOptedOut(context: EvaluationContext): boolean {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn requires ES2022; this package supports ES2018.
  return Object.prototype.hasOwnProperty.call(context, attribute) && context[attribute] === true
}
