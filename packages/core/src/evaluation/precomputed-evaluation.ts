import type { ErrorCode, EvaluationContext, FlagValueType, Logger, ResolutionDetails } from '@openfeature/core'
import {
  configMatchesContext,
  type FlagsConfiguration,
  type FlagTypeToValue,
  type PrecomputedConfiguration,
  type PrecomputedFlagMetadata,
} from '../configuration'
import { encodePrecomputedFlagKey, readFlagKeyObfuscation } from '../configuration/flag-key-obfuscation'
import {
  acknowledgesExperimentationOptOut,
  type ExperimentationOptOutOption,
  experimentationOptOutPolicy,
  INVALID_EXPERIMENTATION_OPT_OUT,
} from './experimentation-opt-out'
import { getOwnProperty } from './getOwnProperty'
import { createSplitFeatureMetadata, HAS_EVALUATION_FEATURES_METADATA_KEY } from './split-features'

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function evaluatePrecomputedConfiguration<T extends FlagValueType>(
  flagsConfiguration: FlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  experimentationOptOutMode: ExperimentationOptOutOption = false,
  logger: Logger = NOOP_LOGGER
): ResolutionDetails<FlagTypeToValue<T>> {
  const optedOut = experimentationOptOutPolicy(context, experimentationOptOutMode)
  if (optedOut === undefined) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
      errorMessage: INVALID_EXPERIMENTATION_OPT_OUT,
    }
  }
  if (
    (optedOut && !flagsConfiguration?.precomputed?.context) ||
    !acknowledgesExperimentationOptOut(flagsConfiguration, optedOut)
  ) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
      errorMessage:
        'Precomputed configuration must match the subject and acknowledge the requested experimentation opt-out policy',
    }
  }
  const selection = selectPrecomputedFlagsConfiguration(flagsConfiguration, context)
  if (selection.kind === 'precomputed') {
    return evaluatePrecomputedFlag(selection.configuration, type, flagKey, defaultValue, logger)
  }

  const { error } = selection
  return {
    value: defaultValue,
    reason: 'ERROR',
    errorCode: error.errorCode as ErrorCode,
    ...(error.errorMessage === undefined ? {} : { errorMessage: error.errorMessage }),
  }
}

type PrecomputedFlagsConfigurationError = {
  errorCode: 'INVALID_CONTEXT' | 'PARSE_ERROR' | 'PROVIDER_NOT_READY'
  errorMessage?: string
}

type PrecomputedFlagsConfigurationSelection =
  | { kind: 'precomputed'; configuration: PrecomputedConfiguration }
  | { kind: 'error'; error: PrecomputedFlagsConfigurationError }

function selectPrecomputedFlagsConfiguration(
  configuration: FlagsConfiguration | undefined,
  context: EvaluationContext
): PrecomputedFlagsConfigurationSelection {
  if (configuration === undefined) {
    return {
      kind: 'error',
      error: { errorCode: 'PROVIDER_NOT_READY', errorMessage: 'No flags configuration has been set' },
    }
  }

  if (configuration.precomputed && configMatchesContext(configuration, context)) {
    return { kind: 'precomputed', configuration: configuration.precomputed }
  }

  const parseError = configuration.configurationError ?? configuration.precomputedError ?? configuration.rulesError
  if (parseError !== undefined) {
    return { kind: 'error', error: { errorCode: 'PARSE_ERROR', errorMessage: parseError } }
  }

  if (configuration.precomputed) {
    return {
      kind: 'error',
      error: {
        errorCode: 'INVALID_CONTEXT',
        errorMessage: 'Precomputed flags configuration does not match the current context',
      },
    }
  }

  return {
    kind: 'error',
    error: { errorCode: 'PARSE_ERROR', errorMessage: 'Flags configuration contains no usable capability' },
  }
}

function evaluatePrecomputedFlag<T extends FlagValueType>(
  precomputed: PrecomputedConfiguration,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  logger: Logger
): ResolutionDetails<FlagTypeToValue<T>> {
  const attributes = precomputed.response.data.attributes
  // Initial configurations and persistent caches can bypass the wire parser.
  const encoding = readFlagKeyObfuscation(attributes.obfuscated, attributes.obfuscation)
  if ('error' in encoding) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: encoding.error,
    }
  }
  const lookup = encoding.encoding ? encodePrecomputedFlagKey(flagKey, encoding.encoding) : { key: flagKey }
  if ('error' in lookup) {
    return { value: defaultValue, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' as ErrorCode }
  }
  const flagError = precomputed.flagErrors ? getOwnProperty(precomputed.flagErrors, lookup.key) : undefined
  if (flagError) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagError,
    }
  }

  const flag = getOwnProperty(attributes.flags, lookup.key)
  if (!flag) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
    }
  }

  if (flag.variationType && variationTypeToOpenFeature(flag.variationType) !== type) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH' as ErrorCode,
    }
  }

  const { entries: featureEntries, hasEvaluationFeatures } = createSplitFeatureMetadata(flag.features, logger)
  return {
    value: flag.variationValue as FlagTypeToValue<T>,
    variant: flag.variationKey,
    flagMetadata: {
      __dd_allocation_key: flag.allocationKey,
      __dd_do_log: flag.doLog,
      ...(typeof flag.serialId === 'number' ? { __dd_split_serial_id: flag.serialId } : {}),
      allocationKey: flag.allocationKey,
      variationType: flag.variationType,
      doLog: flag.doLog,
      ...featureEntries,
      ...(hasEvaluationFeatures ? { [HAS_EVALUATION_FEATURES_METADATA_KEY]: true } : {}),
    } as PrecomputedFlagMetadata,
    reason: flag.reason,
  } as ResolutionDetails<FlagTypeToValue<T>>
}

function variationTypeToOpenFeature(s: string): FlagValueType {
  const typeMap: Record<string, FlagValueType> = {
    string: 'string',
    boolean: 'boolean',
    number: 'number',
    integer: 'number',
    float: 'number',
    object: 'object',

    BOOLEAN: 'boolean',
    STRING: 'string',
    NUMERIC: 'number',
    INTEGER: 'number',
    JSON: 'object',
  }

  return typeMap[s] || s.toLowerCase()
}
