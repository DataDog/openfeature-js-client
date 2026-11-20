import type { EvaluationDetails, FlagMetadata, FlagValue } from '@openfeature/web-sdk'

const DEPENDENCY_EVALUATIONS = Symbol.for('@datadog/flagging/precomputed-dependency-evaluations')

export type PrecomputedDependencyEvaluationDetails = Omit<EvaluationDetails<FlagValue>, 'value'> & {
  value?: FlagValue
  isPresentInAssignment?: boolean
}

type MetadataWithDependencyEvaluations = FlagMetadata & {
  [DEPENDENCY_EVALUATIONS]?: readonly PrecomputedDependencyEvaluationDetails[]
}

export function getPrecomputedDependencyEvaluations(details: {
  flagMetadata?: FlagMetadata
}): readonly PrecomputedDependencyEvaluationDetails[] {
  return details.flagMetadata
    ? ((details.flagMetadata as MetadataWithDependencyEvaluations)[DEPENDENCY_EVALUATIONS] ?? [])
    : []
}

export function inheritPrecomputedDependencyEvaluations(from: FlagMetadata, to: FlagMetadata): void {
  const dependencies = (from as MetadataWithDependencyEvaluations)[DEPENDENCY_EVALUATIONS]
  if (!dependencies) return
  Object.defineProperty(to, DEPENDENCY_EVALUATIONS, {
    configurable: false,
    enumerable: false,
    value: dependencies,
    writable: false,
  })
}
