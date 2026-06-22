import type { FlagTypeToValue, PrecomputedFlagMetadata, UnixTimestamp } from '@datadog/flagging-core'
import {
  ErrorCode,
  type EvaluationContext,
  type FlagValueType,
  type Logger,
  type ResolutionDetails,
  StandardResolutionReasons,
  TargetingKeyMissingError,
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
  const evaluationTimestampMs = Date.now()

  if (!config) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: ErrorCode.PROVIDER_NOT_READY,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  const { targetingKey: subjectKey, ...remainingContext } = context

  // Include the subjectKey as an "id" attribute for rule matching only when present
  const subjectAttributes = {
    ...(subjectKey != null ? { id: subjectKey } : {}),
    ...remainingContext,
  }
  const flag = config.flags[flagKey]
  if (!flag) {
    logger.debug('returning default value because flag is not found', { flagKey, subjectKey })
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.FLAG_NOT_FOUND,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  try {
    const resultWithDetails = evaluateForSubject(
      flag,
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger,
      evaluationTimestampMs
    )
    return resultWithDetails
  } catch (error) {
    if (error instanceof TargetingKeyMissingError) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TARGETING_KEY_MISSING,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
    logger.error('Error evaluating flag', { error })
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }
}

function createEvaluationTimestampMetadata(evaluationTimestampMs: UnixTimestamp): PrecomputedFlagMetadata {
  return { 'dd.eval.timestamp_ms': evaluationTimestampMs } as PrecomputedFlagMetadata
}
