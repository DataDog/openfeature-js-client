import type { FlagTypeToValue } from '@datadog/flagging-core'
import {
  ErrorCode,
  EvaluationContext,
  FlagValueType,
  Logger,
  ResolutionDetails,
  StandardResolutionReasons,
} from '@openfeature/server-sdk'
import { UniversalFlagConfigurationV1 } from './ufc-v1'
import { evaluateForSubject } from './evaluateForSubject'

export function evaluate<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger
): ResolutionDetails<FlagTypeToValue<T>> {
  const { targetingKey: subjectKey, ...remainingContext } = context
  if (!subjectKey) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING' as ErrorCode,
    }
  }

  // Include the subjectKey as an "id" attribute for rule matching
  const subjectAttributes = {
    id: subjectKey,
    ...remainingContext,
  }
  try {
    const resultWithDetails = evaluateForSubject(
      config.flags[flagKey],
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger
    )
    return resultWithDetails
  } catch (error) {
    logger.error('Error evaluating flag', { error })
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
    }
  }
}
