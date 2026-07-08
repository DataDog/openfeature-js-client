import { timeStampNow } from '@datadog/js-core/time'
import type { ErrorCode, EvaluationContext, FlagValueType, Logger, ResolutionDetails } from '@openfeature/core'
import type { FlagTypeToValue } from '../configuration'
import { TargetingKeyMissingError } from './errors'
import { evaluateForSubject } from './evaluateForSubject'
import { createEvaluationTimestampMetadata } from './evaluationMetadata'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'

export function evaluateRulesBasedConfiguration<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger
): ResolutionDetails<FlagTypeToValue<T>> {
  const evaluationTimestampMs = timeStampNow()

  if (!config) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
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
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  try {
    return evaluateForSubject(flag, type, subjectKey, subjectAttributes, defaultValue, logger, evaluationTimestampMs)
  } catch (error) {
    if (error instanceof TargetingKeyMissingError) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'TARGETING_KEY_MISSING' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
    logger.error('Error evaluating flag', { error })
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'GENERAL' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }
}
