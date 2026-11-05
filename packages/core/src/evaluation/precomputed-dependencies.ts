import type { ErrorCode, EvaluationDetails, FlagMetadata, FlagValue, Logger } from '@openfeature/core'
import type { PrecomputedDependencyEvaluation, PrecomputedFlag } from '../configuration'
import type { FlagKeyObfuscation } from '../configuration/flag-key-obfuscation'
import { encodePrecomputedFlagKey } from '../configuration/flag-key-obfuscation'
import { decryptDependencyFlagKey } from '../configuration/dependency-key-encryption'
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
  logger: Logger = NOOP_LOGGER,
  identity?: { rootFlagKey: string; encoding?: FlagKeyObfuscation }
): string | undefined {
  if (!dependencies?.length) return undefined
  const resolved: PrecomputedDependencyEvaluationDetails[] = []
  for (const dependency of dependencies) {
    const details = toEvaluationDetails(
      dependency,
      flags,
      identity?.rootFlagKey ?? '',
      identity?.encoding,
      flagErrors,
      logger
    )
    if ('bindingError' in details) return details.bindingError
    resolved.push(details)
  }
  dependencyEvaluations.set(metadata, resolved)
  return undefined
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
  rootFlagKey: string,
  encoding: FlagKeyObfuscation | undefined,
  flagErrors: Record<string, string> | undefined,
  logger: Logger
): PrecomputedDependencyEvaluationDetails | { bindingError: string } {
  const decrypted = encoding
    ? decryptDependencyFlagKey(dependency.flagKey, rootFlagKey, encoding)
    : { key: dependency.flagKey }
  if ('error' in decrypted) {
    return { bindingError: decrypted.error }
  }
  const lookup = encoding ? encodePrecomputedFlagKey(decrypted.key, encoding) : { key: decrypted.key }
  if ('error' in lookup) {
    return { bindingError: lookup.error }
  }
  if ('errorCode' in dependency) {
    return {
      flagKey: decrypted.key,
      reason: 'ERROR',
      errorCode: dependency.errorCode as ErrorCode,
      ...(dependency.errorMessage === undefined ? {} : { errorMessage: dependency.errorMessage }),
      flagMetadata: {},
    }
  }
  const flag = getOwnProperty(flags, lookup.key)
  const flagError = flagErrors ? getOwnProperty(flagErrors, lookup.key) : undefined
  if (
    flagError !== undefined ||
    !flag ||
    typeof flag.allocationKey !== 'string' ||
    typeof flag.variationKey !== 'string' ||
    typeof flag.reason !== 'string' ||
    typeof flag.doLog !== 'boolean'
  ) {
    return {
      flagKey: decrypted.key,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagError ?? 'Successful dependency evaluation is missing its top-level assignment',
      flagMetadata: {},
    }
  }
  const { entries: featureEntries, hasEvaluationFeatures } = createSplitFeatureMetadata(flag.features, logger)
  return {
    flagKey: decrypted.key,
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
