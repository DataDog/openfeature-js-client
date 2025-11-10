import type {
  FlagsConfiguration,
  FlagTypeToValue,
  PrecomputedConfiguration,
  PrecomputedFlagMetadata,
} from '@datadog/flagging-core'
import type { ErrorCode, EvaluationContext, FlagValueType, ResolutionDetails } from '@openfeature/web-sdk'

export function evaluate<T extends FlagValueType>(
  flagsConfiguration: FlagsConfiguration,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext
): ResolutionDetails<FlagTypeToValue<T>> {
  if (flagsConfiguration.precomputed) {
    return evaluatePrecomputed(flagsConfiguration.precomputed, type, flagKey, defaultValue, context)
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
