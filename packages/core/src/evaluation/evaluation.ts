import type {
  ErrorCode,
  EvaluationContext,
  FlagValue,
  FlagValueType,
  Logger,
  ResolutionDetails,
} from '@openfeature/core'
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
import { DependencyGraphError, TargetingKeyMissingError } from './errors'
import { evaluateForSubject } from './evaluateForSubject'
import { evaluateProtobufConfiguration, protobufVariationTypeToFlagValueType } from './evaluateProtobufConfiguration'
import { createEvaluationMetadata, createEvaluationTimestampMetadata } from './evaluationMetadata'
import { evaluatePrecomputedConfiguration } from './precomputed-evaluation'
import type { FlagEvaluation } from './rules'
import { type Flag, type UniversalFlagConfigurationV1, variantTypeToFlagValueType } from './ufc-v1'

const DEFAULT_MAX_DEPENDENCY_DEPTH = 10

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
  onDependencyEvaluation?: DependencyEvaluationHandler,
  onDependencyExposures?: DependencyExposureHandler
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
      logger,
      onDependencyEvaluation,
      onDependencyExposures
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
  logger: Logger,
  onDependencyEvaluation?: DependencyEvaluationHandler,
  onDependencyExposures?: DependencyExposureHandler
): ResolutionDetails<FlagTypeToValue<T>> {
  const evaluationTimestampMs = timeStampNow()
  // Snapshot consent once at the start of this evaluation. The provider can receive a new
  // configuration later, but hooks must see the consent from the configuration that produced this result.
  const observeFullEvaluationData = config?.observeFullEvaluationData === true
  const metadata = createEvaluationMetadata(evaluationTimestampMs, observeFullEvaluationData)
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
      onDependencyEvaluation,
      onDependencyExposures
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
  onDependencyEvaluation?: DependencyEvaluationHandler,
  onDependencyExposures?: DependencyExposureHandler
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
    const prepared = prepareRulesResponse(config)
    try {
      const maxDependencyDepth = getMaxDependencyDepth(config)
      let dependencySession: DependencyEvaluationSession | undefined
      const result = evaluateProtobufConfiguration(
        prepared,
        type,
        flagKey,
        defaultValue,
        context,
        logger,
        evaluationTimestampMs,
        (dependencyFlagKey) => {
          dependencySession ??= new DependencyEvaluationSession(
            flagKey,
            maxDependencyDepth,
            config.observeFullEvaluationData,
            (key) => {
              const flag = Object.prototype.hasOwnProperty.call(config.flags, key) ? config.flags[key] : undefined
              if (flag === undefined) return undefined
              const dependencyType = protobufVariationTypeToFlagValueType(flag.variationType)
              return { type: dependencyType, defaultValue: defaultValueForType(dependencyType) }
            },
            (key, dependencyType, dependencyDefault, resolveFlagEvaluation) =>
              evaluateProtobufConfiguration(
                prepared,
                dependencyType,
                key,
                dependencyDefault,
                context,
                logger,
                evaluationTimestampMs,
                resolveFlagEvaluation
              ),
            logger,
            evaluationTimestampMs,
            onDependencyEvaluation
          )
          return dependencySession.resolveFlagEvaluation(dependencyFlagKey, 1)
        }
      )
      if (dependencySession !== undefined && result.reason !== 'ERROR' && result.errorCode === undefined) {
        onDependencyExposures?.(dependencySession.exposureCandidates())
      }
      return result
    } catch (error) {
      if (error instanceof DependencyGraphError) {
        return dependencyGraphFailure(error, defaultValue, logger, evaluationTimestampMs)
      }
      throw error
    }
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

  try {
    const maxDependencyDepth = getMaxDependencyDepth(config)
    let dependencySession: DependencyEvaluationSession | undefined
    const evaluated = evaluateForSubject(
      config.flags[flagKey],
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger,
      evaluationTimestampMs,
      (flagEvaluation) => {
        dependencySession ??= new DependencyEvaluationSession(
          flagKey,
          maxDependencyDepth,
          config.observeFullEvaluationData === true,
          (key) => {
            const flag = Object.prototype.hasOwnProperty.call(config.flags, key) ? config.flags[key] : undefined
            if (flag === undefined) return undefined
            return {
              type: variantTypeToFlagValueType(flag.variationType),
              defaultValue: defaultValueForFlag(flag),
            }
          },
          (key, dependencyType, dependencyDefault, resolveFlagEvaluation) =>
            evaluateForSubject(
              config.flags[key],
              dependencyType,
              subjectKey,
              subjectAttributes,
              dependencyDefault,
              logger,
              evaluationTimestampMs,
              (flagEvaluation) => resolveFlagEvaluation(flagEvaluation.key)
            ) as ResolutionDetails<FlagValue>,
          logger,
          evaluationTimestampMs,
          onDependencyEvaluation
        )
        return dependencySession.resolveFlagEvaluation(flagEvaluation, 1)
      }
    )
    const result: ResolutionDetails<FlagTypeToValue<T>> = {
      ...evaluated,
      flagMetadata: {
        ...evaluated.flagMetadata,
        ...createEvaluationMetadata(evaluationTimestampMs, config.observeFullEvaluationData),
      },
    }
    if (dependencySession !== undefined && result.reason !== 'ERROR' && result.errorCode === undefined) {
      onDependencyExposures?.(dependencySession.exposureCandidates())
    }
    return result
  } catch (error) {
    if (error instanceof TargetingKeyMissingError) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'TARGETING_KEY_MISSING' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
    if (error instanceof DependencyGraphError) {
      return dependencyGraphFailure(error, defaultValue, logger, evaluationTimestampMs)
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

function dependencyGraphFailure<T extends FlagValue>(
  error: DependencyGraphError,
  defaultValue: T,
  logger: Logger,
  evaluationTimestampMs: TimeStamp
): ResolutionDetails<T> {
  logger.warn('flag dependency graph evaluation failed', {
    flagKey: error.flagKey,
    errorCode: error.errorCode,
    errorMessage: error.message,
  })
  return {
    value: defaultValue,
    reason: 'ERROR',
    errorCode: error.errorCode,
    errorMessage: error.message,
    flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
  }
}

export type DependencyEvaluation = {
  flagKey: string
  details: ResolutionDetails<FlagValue>
}

export type DependencyExposureCandidate = {
  flagKey: string
  details: ResolutionDetails<FlagValue>
}

export type DependencyEvaluationHandler = (evaluation: DependencyEvaluation) => void
export type DependencyExposureHandler = (evaluations: readonly DependencyExposureCandidate[]) => void

class DependencyEvaluationSession {
  private readonly memo = new Map<string, ResolutionDetails<FlagValue>>()
  private readonly active: Set<string>
  private readonly exposures: DependencyExposureCandidate[] = []

  constructor(
    rootFlagKey: string,
    private readonly maxDependencyDepth: number,
    private readonly observeFullEvaluationData: boolean,
    private readonly getFlag: (flagKey: string) => DependencyFlag | undefined,
    private readonly evaluateFlag: DependencyFlagEvaluator,
    private readonly logger: Logger,
    private readonly evaluationTimestampMs: TimeStamp,
    private readonly onDependencyEvaluation?: DependencyEvaluationHandler
  ) {
    this.active = new Set([rootFlagKey])
  }

  exposureCandidates(): readonly DependencyExposureCandidate[] {
    return this.exposures
  }

  private evaluate(
    flagKey: string,
    type: FlagValueType,
    defaultValue: FlagValue,
    depth: number
  ): ResolutionDetails<FlagValue> {
    const memoized = this.memo.get(flagKey)
    if (memoized !== undefined) {
      return memoized
    }

    const flag = this.getFlag(flagKey)
    if (flag === undefined) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(this.evaluationTimestampMs),
      }
    }

    this.active.add(flagKey)
    try {
      const evaluated = this.evaluateFlag(flagKey, type, defaultValue, (dependencyFlagKey) =>
        this.resolveFlagEvaluation(dependencyFlagKey, depth + 1)
      )
      const result: ResolutionDetails<FlagValue> = {
        ...evaluated,
        flagMetadata: {
          ...evaluated.flagMetadata,
          ...createEvaluationMetadata(this.evaluationTimestampMs, this.observeFullEvaluationData),
        },
      }
      if (result.reason === 'ERROR' || result.errorCode !== undefined) {
        throw new DependencyGraphError(
          flagKey,
          result.errorCode ?? ('GENERAL' as ErrorCode),
          result.errorMessage ?? 'prerequisite flag evaluation failed'
        )
      }
      if (result.variant === undefined) {
        throw new DependencyGraphError(
          flagKey,
          'GENERAL' as ErrorCode,
          'prerequisite flag evaluation returned no variant'
        )
      }
      this.memo.set(flagKey, result)
      const evaluation = { flagKey, details: result }
      this.exposures.push(evaluation)
      this.emitEvaluation(evaluation)
      return result
    } catch (error) {
      const graphError = this.toDependencyGraphError(flagKey, error)
      this.emitEvaluation({
        flagKey,
        details: {
          value: defaultValue,
          reason: 'ERROR',
          errorCode: graphError.errorCode,
          errorMessage: graphError.message,
          flagMetadata: createEvaluationMetadata(this.evaluationTimestampMs, this.observeFullEvaluationData),
        },
      })
      throw graphError
    } finally {
      this.active.delete(flagKey)
    }
  }

  resolveFlagEvaluation(flagEvaluation: FlagEvaluation | string, depth: number): string | undefined {
    const flagKey = typeof flagEvaluation === 'string' ? flagEvaluation : flagEvaluation.key
    if (depth > this.maxDependencyDepth) {
      this.logger.warn('maximum flag dependency depth exceeded', {
        flagKey,
        maxDependencyDepth: this.maxDependencyDepth,
      })
      throw new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'maximum flag dependency depth exceeded')
    }
    if (this.active.has(flagKey)) {
      this.logger.warn('flag dependency cycle detected', { flagKey })
      throw new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'flag dependency cycle detected')
    }

    const flag = this.getFlag(flagKey)
    if (flag === undefined) {
      this.logger.warn('prerequisite flag is missing', { flagKey })
      throw new DependencyGraphError(flagKey, 'FLAG_NOT_FOUND' as ErrorCode, 'prerequisite flag is missing')
    }

    const result = this.evaluate(flagKey, flag.type, flag.defaultValue, depth)
    return result.variant
  }

  private toDependencyGraphError(flagKey: string, error: unknown): DependencyGraphError {
    if (error instanceof DependencyGraphError) {
      return error
    }
    if (error instanceof TargetingKeyMissingError) {
      return new DependencyGraphError(flagKey, 'TARGETING_KEY_MISSING' as ErrorCode, error.message)
    }
    this.logger.error('Error evaluating prerequisite flag', { flagKey, error })
    return new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'prerequisite flag evaluation failed')
  }

  private emitEvaluation(evaluation: DependencyEvaluation): void {
    try {
      this.onDependencyEvaluation?.(evaluation)
    } catch {
      // Evaluation telemetry is best effort and must not affect flag evaluation semantics.
    }
  }
}

type DependencyFlag = {
  type: FlagValueType
  defaultValue: FlagValue
}

type DependencyFlagEvaluator = (
  flagKey: string,
  type: FlagValueType,
  defaultValue: FlagValue,
  resolveFlagEvaluation: (flagKey: string) => string | undefined
) => ResolutionDetails<FlagValue>

function getMaxDependencyDepth(config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration): number {
  const configuredDepth = config.evaluatorParams?.maxDependencyDepth
  if (configuredDepth === undefined) {
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  const numericDepth = typeof configuredDepth === 'bigint' ? Number(configuredDepth) : configuredDepth
  if (Number.isInteger(numericDepth) && numericDepth >= 0 && numericDepth <= 255) {
    return numericDepth
  }
  throw new DependencyGraphError(
    '',
    'PARSE_ERROR' as ErrorCode,
    'maxDependencyDepth must be an integer from 0 through 255'
  )
}

function defaultValueForType(type: FlagValueType): FlagValue {
  switch (type) {
    case 'boolean':
      return false
    case 'number':
      return 0
    case 'string':
      return ''
    case 'object':
      return {}
  }
}

function defaultValueForFlag(flag: Flag): FlagValue {
  switch (flag.variationType) {
    case 'BOOLEAN':
      return false
    case 'INTEGER':
    case 'NUMERIC':
      return 0
    case 'STRING':
      return ''
    case 'JSON':
      return {}
  }
}

function isProtobufConfiguration(
  configuration: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration
): configuration is ProtobufFlagsConfiguration {
  return '$typeName' in configuration && configuration.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration'
}
