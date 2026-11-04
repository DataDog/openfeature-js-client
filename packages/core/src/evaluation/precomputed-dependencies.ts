import type { ErrorCode, EvaluationDetails, FlagMetadata, FlagValue } from '@openfeature/core'
import type { PrecomputedDependencyEvaluation, PrecomputedFlag } from '../configuration'
import { getOwnProperty } from './getOwnProperty'

export type PrecomputedDependencyEvaluationDetails = Omit<EvaluationDetails<FlagValue>, 'value'> & {
  value?: FlagValue
  /** Successful dependencies only; errors are reached-evaluation telemetry. */
  isPresentInAssignment?: boolean
}

const dependencyEvaluations = new WeakMap<FlagMetadata, readonly PrecomputedDependencyEvaluationDetails[]>()

export function bindPrecomputedDependencyEvaluations(
  metadata: FlagMetadata,
  dependencies: readonly PrecomputedDependencyEvaluation[] | undefined,
  flags: Record<string, PrecomputedFlag>,
  flagErrors?: Record<string, string>
): void {
  if (!dependencies?.length) return
  dependencyEvaluations.set(
    metadata,
    dependencies.map((dependency) => toEvaluationDetails(dependency, flags, flagErrors))
  )
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

function toEvaluationDetails(
  dependency: PrecomputedDependencyEvaluation,
  flags: Record<string, PrecomputedFlag>,
  flagErrors: Record<string, string> | undefined
): PrecomputedDependencyEvaluationDetails {
  if ('errorCode' in dependency) {
    return {
      flagKey: dependency.flagKey,
      reason: 'ERROR',
      errorCode: dependency.errorCode as ErrorCode,
      flagMetadata: {},
    }
  }
  const flag = getOwnProperty(flags, dependency.flagKey)
  const flagError = flagErrors ? getOwnProperty(flagErrors, dependency.flagKey) : undefined
  if (
    flagError !== undefined ||
    !flag ||
    'errorCode' in flag ||
    typeof flag.allocationKey !== 'string' ||
    typeof flag.variationKey !== 'string' ||
    typeof flag.reason !== 'string' ||
    typeof flag.doLog !== 'boolean'
  ) {
    return {
      flagKey: dependency.flagKey,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagError ?? 'Successful dependency evaluation is missing its top-level assignment',
      flagMetadata: {},
    }
  }
  return {
    flagKey: dependency.flagKey,
    variant: flag.variationKey,
    reason: flag.reason,
    isPresentInAssignment: dependency.isPresentInAssignment,
    flagMetadata: {
      __dd_allocation_key: flag.allocationKey,
      __dd_do_log: flag.doLog,
      allocationKey: flag.allocationKey,
      doLog: flag.doLog,
      ...(typeof flag.serialId === 'number' ? { __dd_split_serial_id: flag.serialId } : {}),
    },
  }
}
