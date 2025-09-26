import type { FlagsConfiguration, FlagTypeToValue, PrecomputedConfiguration } from '@datadog/flagging-core'
import type { PrecomputedFlagMetadata } from '@datadog/flagging-core/src/configuration/configuration'
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

  if (flag.variationType && flag.variationType.toLowerCase() !== type.toLowerCase()) {
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
      doLog: flag.doLog,
    } satisfies PrecomputedFlagMetadata,
    reason: flag.reason,
  } as ResolutionDetails<FlagTypeToValue<T>>
}
