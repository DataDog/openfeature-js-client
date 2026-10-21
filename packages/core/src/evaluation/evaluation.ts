import type { ErrorCode, EvaluationContext, FlagValueType, Logger, ResolutionDetails } from '@openfeature/core'
import {
  configMatchesContext,
  type FlagsConfiguration,
  type FlagTypeToValue,
  type PrecomputedConfiguration,
  type RulesConfiguration,
} from '../configuration'
import type { FlagsConfiguration as ProtobufFlagsConfiguration } from '../configuration/generated/ufc_pb'
import { prepareRulesResponse } from '../configuration/prepared-rules-response'
import { type TimeStamp, timeStampNow } from '../time'
import { TargetingKeyMissingError } from './errors'
import { evaluateForSubject } from './evaluateForSubject'
import { evaluateProtobufConfiguration } from './evaluateProtobufConfiguration'
import { createEvaluationMetadata, createEvaluationTimestampMetadata } from './evaluationMetadata'
import {
  acknowledgesExperimentationOptOut,
  type ExperimentationOptOutOption,
  type ExperimentationOptOutPolicy,
  experimentationOptOutPolicy,
  INVALID_EXPERIMENTATION_OPT_OUT,
} from './experimentation-opt-out'
import { evaluatePrecomputedConfiguration } from './precomputed-evaluation'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export function evaluate<T extends FlagValueType>(
  flagsConfiguration: FlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger = NOOP_LOGGER,
  experimentationOptOutMode: ExperimentationOptOutOption = false
): ResolutionDetails<FlagTypeToValue<T>> {
  const selection = selectFlagsConfiguration(flagsConfiguration, context, experimentationOptOutMode)
  if (selection.kind === 'precomputed') {
    return evaluatePrecomputedConfiguration(flagsConfiguration, type, flagKey, defaultValue, context)
  }

  if (selection.kind === 'rules') {
    return evaluateRulesBasedConfiguration(
      selection.configuration.response,
      type,
      flagKey,
      defaultValue,
      context,
      logger,
      experimentationOptOutMode
    )
  }

  const { error } = selection
  return {
    value: defaultValue,
    reason: 'ERROR',
    errorCode: error.errorCode as ErrorCode,
    ...(error.errorMessage === undefined ? {} : { errorMessage: error.errorMessage }),
  }
}

export type FlagsConfigurationError = {
  errorCode: 'INVALID_CONTEXT' | 'PARSE_ERROR' | 'PROVIDER_NOT_READY'
  errorMessage?: string
}

/** Return the lifecycle/evaluation error when no configuration capability can serve the context. */
export function getFlagsConfigurationError(
  configuration: FlagsConfiguration | undefined,
  context: EvaluationContext,
  experimentationOptOutMode: ExperimentationOptOutOption = false
): FlagsConfigurationError | undefined {
  const selection = selectFlagsConfiguration(configuration, context, experimentationOptOutMode)
  return selection.kind === 'error' ? selection.error : undefined
}

type FlagsConfigurationSelection =
  | { kind: 'precomputed'; configuration: PrecomputedConfiguration }
  | { kind: 'rules'; configuration: RulesConfiguration }
  | { kind: 'error'; error: FlagsConfigurationError }

function selectFlagsConfiguration(
  configuration: FlagsConfiguration | undefined,
  context: EvaluationContext,
  experimentationOptOutMode: ExperimentationOptOutOption = false
): FlagsConfigurationSelection {
  const optedOut = experimentationOptOutPolicy(context, experimentationOptOutMode)
  if (optedOut === undefined) {
    return { kind: 'error', error: { errorCode: 'INVALID_CONTEXT', errorMessage: INVALID_EXPERIMENTATION_OPT_OUT } }
  }
  if (configuration === undefined) {
    return {
      kind: 'error',
      error: { errorCode: 'PROVIDER_NOT_READY', errorMessage: 'No flags configuration has been set' },
    }
  }

  if (
    configuration.precomputed &&
    configMatchesContext(configuration, context) &&
    (!optedOut ||
      (configuration.precomputed.context !== undefined && acknowledgesExperimentationOptOut(configuration, optedOut)))
  ) {
    return { kind: 'precomputed', configuration: configuration.precomputed }
  }
  if (configuration.rules) {
    return { kind: 'rules', configuration: configuration.rules }
  }

  if (optedOut && configuration.precomputed) {
    return {
      kind: 'error',
      error: {
        errorCode: 'INVALID_CONTEXT',
        errorMessage:
          'Precomputed configuration must match the opted-out subject and acknowledge experimentation opt-out',
      },
    }
  }

  const parseError = configuration.configurationError ?? configuration.rulesError ?? configuration.precomputedError
  if (parseError !== undefined) {
    return { kind: 'error', error: { errorCode: 'PARSE_ERROR', errorMessage: parseError } }
  }

  if (configuration.precomputed) {
    return {
      kind: 'error',
      error: {
        errorCode: 'INVALID_CONTEXT',
        errorMessage: 'Precomputed flags configuration does not match the current context',
      },
    }
  }

  return {
    kind: 'error',
    error: { errorCode: 'PARSE_ERROR', errorMessage: 'Flags configuration contains no usable capability' },
  }
}

export function evaluateRulesBasedConfiguration<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  experimentationOptOutMode: ExperimentationOptOutOption = false
): ResolutionDetails<FlagTypeToValue<T>> {
  const evaluationTimestampMs = timeStampNow()
  // Snapshot consent once at the start of this evaluation. The provider can receive a new
  // configuration later, but hooks must see the consent from the configuration that produced this result.
  const observeFullEvaluationData = config?.observeFullEvaluationData === true
  const metadata = createEvaluationMetadata(evaluationTimestampMs, observeFullEvaluationData)
  const excludeExperiments = experimentationOptOutPolicy(context, experimentationOptOutMode)
  if (excludeExperiments === undefined) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT' as ErrorCode,
      errorMessage: INVALID_EXPERIMENTATION_OPT_OUT,
      flagMetadata: metadata,
    }
  }
  let details: ResolutionDetails<FlagTypeToValue<T>>
  try {
    details = evaluateRules(
      config,
      type,
      flagKey,
      defaultValue,
      context,
      logger,
      evaluationTimestampMs,
      excludeExperiments
    )
  } catch (error) {
    logger.error('Error evaluating flag', { error })
    details = { value: defaultValue, reason: 'ERROR', errorCode: 'GENERAL' as ErrorCode }
  }
  return { ...details, flagMetadata: { ...details.flagMetadata, ...metadata } }
}

function evaluateRules<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  evaluationTimestampMs: TimeStamp,
  excludeExperiments: ExperimentationOptOutPolicy
): ResolutionDetails<FlagTypeToValue<T>> {
  if (!config) {
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  if (isProtobufConfiguration(config)) {
    return evaluateProtobufConfiguration(
      prepareRulesResponse(config),
      type,
      flagKey,
      defaultValue,
      context,
      logger,
      evaluationTimestampMs,
      excludeExperiments
    )
  }

  const { targetingKey: subjectKey, ...remainingContext } = context

  // Include the subjectKey as an "id" attribute for rule matching only when present
  const subjectAttributes = {
    ...(subjectKey != null ? { id: subjectKey } : {}),
    ...remainingContext,
  }
  if (!Object.prototype.hasOwnProperty.call(config.flags, flagKey)) {
    logger.debug('returning default value because flag is not found', { flagKey, subjectKey })
    return {
      value: defaultValue,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
      flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
    }
  }

  const flag = config.flags[flagKey]
  try {
    return evaluateForSubject(
      flag,
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger,
      evaluationTimestampMs,
      excludeExperiments
    )
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

function isProtobufConfiguration(
  configuration: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration
): configuration is ProtobufFlagsConfiguration {
  return '$typeName' in configuration && configuration.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration'
}
