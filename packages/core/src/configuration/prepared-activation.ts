import { type OptOutInstant, parseOptOutInstant } from '../evaluation/experimentation-opt-out'
import type { Allocation, Flag, UniversalFlagConfigurationV1 } from '../evaluation/ufc-v1'

export type RandomizationActivation =
  { kind: 'missing' } | { kind: 'valid'; instant: OptOutInstant } | { kind: 'invalid' }

export type PreparedAllocations<T> =
  | { valid: false }
  | { valid: true; allocations: ReadonlyArray<{ allocation: T; activation: OptOutInstant | undefined }> }

/** Validate every allocation, including unreachable ones, before evaluating any subject. */
export function prepareAllocations<T>(
  allocations: readonly T[],
  activationFor: (allocation: T) => RandomizationActivation
): PreparedAllocations<T> {
  const prepared = []
  for (const allocation of allocations) {
    const activation = activationFor(allocation)
    if (activation.kind === 'invalid') return { valid: false }
    prepared.push({ allocation, activation: activation.kind === 'valid' ? activation.instant : undefined })
  }
  return { valid: true, allocations: prepared }
}

const jsonActivations = new WeakMap<Flag, PreparedAllocations<Allocation>>()

/**
 * Prepare a received JSON configuration. Configurations are snapshots: replace changed
 * flags instead of mutating them after preparation. Nothing is added to the wire data.
 */
export function prepareUniversalFlagConfiguration(
  configuration: UniversalFlagConfigurationV1
): UniversalFlagConfigurationV1 {
  for (const flag of Object.values(configuration.flags)) {
    // Leave malformed flag shapes to the existing per-flag validation.
    if (flag && Array.isArray(flag.allocations)) prepareJsonFlagActivations(flag)
  }
  return configuration
}

/** Raw low-level callers retain one-time preparation; providers prepare eagerly on receipt. */
export function prepareJsonFlagActivations(flag: Flag): PreparedAllocations<Allocation> {
  const cached = jsonActivations.get(flag)
  if (cached) return cached
  const prepared = prepareAllocations(flag.allocations, (allocation) => {
    const activation = allocation?.randomizationActivatedAt
    if (activation == null) return { kind: 'missing' }
    const instant = parseOptOutInstant(activation)
    return instant ? { kind: 'valid', instant } : { kind: 'invalid' }
  })
  jsonActivations.set(flag, prepared)
  return prepared
}
