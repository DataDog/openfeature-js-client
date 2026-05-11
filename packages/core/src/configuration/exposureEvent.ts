import type { EvaluationContext, EvaluationDetails, FlagValue } from '@openfeature/core'
import type { ExposureEvent } from './exposureEvent.types'

export function createExposureEvent<T extends FlagValue>(
  context: EvaluationContext,
  details: EvaluationDetails<T>
): ExposureEvent | undefined {
  // Only log if doLog flag is true (prefer new key, fallback to deprecated)
  const doLog = details.flagMetadata?.__dd_do_log ?? details.flagMetadata?.doLog
  if (!doLog) {
    return
  }

  // Skip logging if allocation key or variant is missing (this should never happen)
  // Prefer new key, fallback to deprecated
  const allocationKey = (details.flagMetadata?.__dd_allocation_key ?? details.flagMetadata?.allocationKey) as string
  const variantKey = details.variant
  if (!allocationKey || !variantKey) {
    return
  }

  const { targetingKey: id = '', ...attributes } = context

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
  } satisfies ExposureEvent
}
