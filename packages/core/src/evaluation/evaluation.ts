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
import { timeStampNow } from '../time'
import { TargetingKeyMissingError } from './errors'
import { evaluateForSubject } from './evaluateForSubject'
import { evaluateProtobufConfiguration } from './evaluateProtobufConfiguration'
import { createEvaluationTimestampMetadata } from './evaluationMetadata'
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
  logger: Logger = NOOP_LOGGER
): ResolutionDetails<FlagTypeToValue<T>> {
  const selection = selectFlagsConfiguration(flagsConfiguration, context)
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
      logger
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
  context: EvaluationContext
): FlagsConfigurationError | undefined {
  const selection = selectFlagsConfiguration(configuration, context)
  return selection.kind === 'error' ? selection.error : undefined
}

type FlagsConfigurationSelection =
  | { kind: 'precomputed'; configuration: PrecomputedConfiguration }
  | { kind: 'rules'; configuration: RulesConfiguration }
  | { kind: 'error'; error: FlagsConfigurationError }

function selectFlagsConfiguration(
  configuration: FlagsConfiguration | undefined,
  context: EvaluationContext
): FlagsConfigurationSelection {
  if (configuration === undefined) {
    return {
      kind: 'error',
      error: { errorCode: 'PROVIDER_NOT_READY', errorMessage: 'No flags configuration has been set' },
    }
  }

  if (configuration.precomputed && configMatchesContext(configuration, context)) {
    return { kind: 'precomputed', configuration: configuration.precomputed }
  }
  if (configuration.rules) {
    return { kind: 'rules', configuration: configuration.rules }
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

  if (isProtobufConfiguration(config)) {
    return evaluateProtobufConfiguration(
      prepareRulesResponse(config),
      type,
      flagKey,
      defaultValue,
      context,
      logger,
      evaluationTimestampMs
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

function isProtobufConfiguration(
  configuration: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration
): configuration is ProtobufFlagsConfiguration {
  return '$typeName' in configuration && configuration.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration'
}
