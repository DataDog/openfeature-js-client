import type { ErrorCode, EvaluationDetails, FlagMetadata, FlagValue, Logger } from '@openfeature/core'
import type { PrecomputedDependencyEvaluation, PrecomputedFlag } from '../configuration'
import type { FlagKeyObfuscation } from '../configuration/flag-key-obfuscation'
import { encodePrecomputedFlagKey } from '../configuration/flag-key-obfuscation'
import { getOwnProperty } from './getOwnProperty'
import { createSplitFeatureMetadata, HAS_EVALUATION_FEATURES_METADATA_KEY } from './split-features'

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

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
  flagErrors?: Record<string, string>,
  encoding?: FlagKeyObfuscation,
  logger: Logger = NOOP_LOGGER
): void {
  if (!dependencies?.length) return
  dependencyEvaluations.set(
    metadata,
    dependencies.map((dependency) => toEvaluationDetails(dependency, flags, flagErrors, encoding, logger))
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
  flagErrors: Record<string, string> | undefined,
  encoding: FlagKeyObfuscation | undefined,
  logger: Logger
): PrecomputedDependencyEvaluationDetails {
  if ('errorCode' in dependency) {
    return {
      flagKey: dependency.flagKey,
      reason: 'ERROR',
      errorCode: dependency.errorCode as ErrorCode,
      flagMetadata: {},
    }
  }
  const lookup = encoding ? encodePrecomputedFlagKey(dependency.flagKey, encoding) : { key: dependency.flagKey }
  const flag = 'error' in lookup ? undefined : getOwnProperty(flags, lookup.key)
  const flagError = flagErrors && !('error' in lookup) ? getOwnProperty(flagErrors, lookup.key) : undefined
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
  const { entries: featureEntries, hasEvaluationFeatures } = createSplitFeatureMetadata(flag.features, logger)
  return {
    flagKey: dependency.flagKey,
    value: flag.variationValue,
    variant: flag.variationKey,
    reason: flag.reason,
    isPresentInAssignment: dependency.isPresentInAssignment,
    flagMetadata: {
      __dd_allocation_key: flag.allocationKey,
      __dd_do_log: flag.doLog,
      allocationKey: flag.allocationKey,
      doLog: flag.doLog,
      ...(typeof flag.serialId === 'number' ? { __dd_split_serial_id: flag.serialId } : {}),
      ...featureEntries,
      ...(hasEvaluationFeatures ? { [HAS_EVALUATION_FEATURES_METADATA_KEY]: true } : {}),
    },
  }
}
