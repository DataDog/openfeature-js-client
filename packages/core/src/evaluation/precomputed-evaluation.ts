import type { ErrorCode, EvaluationContext, FlagValueType, ResolutionDetails } from '@openfeature/core'
import {
  configMatchesContext,
  type FlagsConfiguration,
  type FlagTypeToValue,
  type PrecomputedConfiguration,
  type PrecomputedFlagMetadata,
} from '../configuration'
import { getOwnProperty } from './getOwnProperty'

export function evaluatePrecomputedConfiguration<T extends FlagValueType>(
  flagsConfiguration: FlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext
): ResolutionDetails<FlagTypeToValue<T>> {
  const selection = selectPrecomputedFlagsConfiguration(flagsConfiguration, context)
  if (selection.kind === 'precomputed') {
    return evaluatePrecomputedFlag(selection.configuration, type, flagKey, defaultValue)
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
  defaultValue: FlagTypeToValue<T>
): ResolutionDetails<FlagTypeToValue<T>> {
  const flagError = precomputed.flagErrors ? getOwnProperty(precomputed.flagErrors, flagKey) : undefined
  if (flagError) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagError,
    }
  }

  const flag = getOwnProperty(precomputed.response.data.attributes.flags, flagKey)
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

  return {
    value: flag.variationValue as FlagTypeToValue<T>,
    variant: flag.variationKey,
    flagMetadata: {
      allocationKey: flag.allocationKey,
      variationType: flag.variationType,
      doLog: flag.doLog,
      ...(typeof flag.serialId === 'number' ? { __dd_split_serial_id: flag.serialId } : {}),
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
