import type { EvaluationContext, EvaluationDetails, FlagValue } from '@openfeature/core'
import type { ExposureEvent } from './exposureEvent.types'

export function createExposureEvent<T extends FlagValue>(
  context: EvaluationContext,
  details: EvaluationDetails<T>
): ExposureEvent | undefined {
  // Only log if doLog flag is true
  if (!details.flagMetadata?.doLog) {
    return
  }

  // Skip logging if allocation key or variant is missing (this should never happen)
  const allocationKey = details.flagMetadata?.allocationKey as string
  const variantKey = details.variant
  if (!allocationKey || !variantKey) {
    return
  }

  const { targetingKey: id = '', ...attributes } = context
  const holdoutKey = details.flagMetadata?.__dd_holdout_key as string | undefined
  const holdoutVariation = details.flagMetadata?.__dd_holdout_variation as string | undefined

  return {
    allocation: {
      key: allocationKey,
    },
    flag: {
      key: details.flagKey,
    },
    variant: {
      key: variantKey,
    },
    subject: {
      id,
      attributes,
    },
    ...(holdoutKey &&
      holdoutVariation && {
        holdout: {
          key: holdoutKey,
          experiment_id: details.flagMetadata?.__dd_holdout_experiment_id as string | undefined,
          variation: holdoutVariation,
          base_allocation_key: details.flagMetadata?.__dd_holdout_base_allocation_key as string | undefined,
        },
      }),
  } satisfies ExposureEvent
}
