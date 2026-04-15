import type { FlagTypeToValue } from '@datadog/flagging-core'
import {
  type EvaluationContext,
  type FlagValueType,
  type Logger,
  TargetingKeyMissingError,
} from '@openfeature/server-sdk'
import { evaluateForSubject } from './evaluateForSubject'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'
import {
  DDFlagEvaluationDetailsBuilder,
  type DDFlagEvaluationDetails,
  FlagEvaluationOutcomeCode,
} from './flagEvaluationDetails'

export function evaluate<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
): DDFlagEvaluationDetails<FlagTypeToValue<T>> {
  const configMeta = config
    ? { configFetchedAt: config.createdAt, environmentName: config.environment.name }
    : { configFetchedAt: null, environmentName: null }

  const noAllocBuilder = () =>
    new DDFlagEvaluationDetailsBuilder(flagKey, [], configMeta.configFetchedAt, configMeta.environmentName)

  if (!config) {
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.PROVIDER_NOT_READY,
      'Configuration is not loaded', null)
  }

  const { targetingKey: subjectKey, ...remainingContext } = context

  const flag = config.flags[flagKey]
  if (!flag) {
    logger.debug('returning default value because flag is not found', { flagKey, subjectKey })
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.FLAG_NOT_FOUND,
      `Flag '${flagKey}' not found in configuration`, null)
  }

  // Include the subjectKey as an "id" attribute for rule matching only when present
  const subjectAttributes = {
    ...(subjectKey != null ? { id: subjectKey } : {}),
    ...remainingContext,
  }

  try {
    return evaluateForSubject(
      flag, type, subjectKey, subjectAttributes, defaultValue, logger,
      configMeta.configFetchedAt, configMeta.environmentName,
    )
  } catch (error) {
    if (error instanceof TargetingKeyMissingError) {
      // TargetingKeyMissingError is thrown inside selectSplitUsingSharding when subjectKey is
      // null and sharding is required. Any allocation-level progress made before the throw
      // (recorded inside the builder in evaluateForSubject) is discarded here — this catch
      // has no access to that builder. TARGETING_KEY_MISSING is in PRE_WATERFALL_CODES, so
      // the empty allocation lists in the result are correct per the contract.
      return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING,
        'targetingKey is required but was not provided', flag.variationType)
    }
    // evaluateForSubject is an in-process pure function; exceptions here are programming
    // errors, not expected failure modes. We catch to preserve the OpenFeature contract
    // (evaluation must never throw). The allocation trace from any mid-waterfall progress
    // is lost — the catch has no access to the builder inside evaluateForSubject.
    logger.error('Error evaluating flag', { error })
    const description = error instanceof Error ? error.message : String(error)
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.ERROR,
      description, flag.variationType)
  }
}
