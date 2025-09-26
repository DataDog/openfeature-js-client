import type { FlagTypeToValue } from '@datadog/flagging-core'
import {
  ErrorCode,
  type EvaluationContext,
  type FlagValueType,
  type Logger,
  type ResolutionDetails,
  StandardResolutionReasons,
} from '@openfeature/server-sdk'
import { evaluateForSubject } from './evaluateForSubject'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'

export function evaluate<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger
): ResolutionDetails<FlagTypeToValue<T>> {
  if (!config) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: ErrorCode.PROVIDER_NOT_READY,
    }
  }

  const { targetingKey: subjectKey, ...remainingContext } = context
  if (!subjectKey) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: ErrorCode.TARGETING_KEY_MISSING,
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
