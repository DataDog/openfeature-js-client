import type { ErrorCode, EvaluationDetails, FlagMetadata, FlagValue } from '@openfeature/core'
import type { PrecomputedDependencyEvaluation } from '../configuration'

export type PrecomputedDependencyEvaluationDetails = Omit<EvaluationDetails<FlagValue>, 'value'> & {
  value?: FlagValue
}

const dependencyEvaluations = new WeakMap<FlagMetadata, readonly PrecomputedDependencyEvaluationDetails[]>()

export function bindPrecomputedDependencyEvaluations(
  metadata: FlagMetadata,
  dependencies: readonly PrecomputedDependencyEvaluation[] | undefined
): void {
  if (!dependencies?.length) return
  dependencyEvaluations.set(metadata, dependencies.map(toEvaluationDetails))
}

export function inheritPrecomputedDependencyEvaluations(from: FlagMetadata, to: FlagMetadata): void {
  const dependencies = dependencyEvaluations.get(from)
  if (dependencies) dependencyEvaluations.set(to, dependencies)
}

export function getPrecomputedDependencyEvaluations(details: {
  flagMetadata?: FlagMetadata
}): readonly PrecomputedDependencyEvaluationDetails[] {
  return details.flagMetadata ? (dependencyEvaluations.get(details.flagMetadata) ?? []) : []
}

function toEvaluationDetails(dependency: PrecomputedDependencyEvaluation): PrecomputedDependencyEvaluationDetails {
  if ('errorCode' in dependency) {
    return {
      flagKey: dependency.flagKey,
      reason: 'ERROR',
      errorCode: dependency.errorCode as ErrorCode,
      flagMetadata: {},
    }
  }
  return {
    flagKey: dependency.flagKey,
    variant: dependency.variationKey,
    reason: dependency.reason,
    flagMetadata: {
      allocationKey: dependency.allocationKey,
      doLog: dependency.doLog,
      ...(typeof dependency.serialId === 'number' ? { __dd_split_serial_id: dependency.serialId } : {}),
    },
  }
}
