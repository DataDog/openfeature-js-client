import type {
  FlagsConfiguration,
  FlagTypeToValue,
  PrecomputedConfiguration,
  PrecomputedFlagMetadata,
} from '@datadog/flagging-core'
import { configMatchesContext, evaluateRulesBasedConfiguration } from '@datadog/flagging-core'
import type { ErrorCode, EvaluationContext, FlagValueType, Logger, ResolutionDetails } from '@openfeature/web-sdk'

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function evaluate<T extends FlagValueType>(
  flagsConfiguration: FlagsConfiguration,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger = NOOP_LOGGER
): ResolutionDetails<FlagTypeToValue<T>> {
  if (flagsConfiguration.precomputedError) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagsConfiguration.precomputedError,
    }
  }

  if (flagsConfiguration.precomputed && configMatchesContext(flagsConfiguration, context)) {
    return evaluatePrecomputed(flagsConfiguration.precomputed, type, flagKey, defaultValue, context)
  }

  if (flagsConfiguration.rules) {
    return evaluateRulesBasedConfiguration(
      flagsConfiguration.rules.response,
      type,
      flagKey,
      defaultValue,
      context,
      logger
    )
  }

  if (flagsConfiguration.precomputed) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
    }
  }

  return {
    value: defaultValue,
    reason: 'DEFAULT',
  }
}

function evaluatePrecomputed<T extends FlagValueType>(
  precomputed: PrecomputedConfiguration,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  _context: EvaluationContext
): ResolutionDetails<FlagTypeToValue<T>> {
  const flagError =
    precomputed.flagErrors && Object.prototype.hasOwnProperty.call(precomputed.flagErrors, flagKey)
      ? precomputed.flagErrors[flagKey]
      : undefined
  if (flagError) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR' as ErrorCode,
      errorMessage: flagError,
    }
  }

  const flag = precomputed.response.data.attributes.flags[flagKey]
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
      extraLogging: flag.extraLogging,
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
