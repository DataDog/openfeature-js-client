import type { ErrorCode, EvaluationDetails, FlagMetadata, FlagValue, Logger } from '@openfeature/core'
import type { PrecomputedDependencyEvaluation, PrecomputedFlag } from '../configuration'
import { decryptDependencyFlagKey } from '../configuration/dependency-key-encryption'
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

const DEPENDENCY_EVALUATIONS = Symbol.for('@datadog/flagging/precomputed-dependency-evaluations')

type MetadataWithDependencyEvaluations = FlagMetadata & {
  [DEPENDENCY_EVALUATIONS]?: readonly PrecomputedDependencyEvaluationDetails[]
}

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
  Object.defineProperty(metadata, DEPENDENCY_EVALUATIONS, {
    configurable: false,
    enumerable: false,
    value: Object.freeze(resolved),
    writable: false,
  })
  return undefined
}

export function getPrecomputedDependencyEvaluations(details: {
  flagMetadata?: FlagMetadata
}): readonly PrecomputedDependencyEvaluationDetails[] {
  return details.flagMetadata
    ? ((details.flagMetadata as MetadataWithDependencyEvaluations)[DEPENDENCY_EVALUATIONS] ?? [])
    : []
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
  if (isDependencyError(dependency)) {
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
    flag.reason === 'ERROR' ||
    typeof flag.doLog !== 'boolean'
  ) {
    return { bindingError: flagError ?? 'Successful dependency evaluation is missing its top-level assignment' }
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

function isDependencyError(
  dependency: PrecomputedDependencyEvaluation
): dependency is Extract<PrecomputedDependencyEvaluation, { reason: 'ERROR' }> {
  return 'reason' in dependency && dependency.reason === 'ERROR' && typeof dependency.errorCode === 'string'
}
