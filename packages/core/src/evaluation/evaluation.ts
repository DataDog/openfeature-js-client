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
import { type PreparedRulesResponse, prepareRulesResponse } from '../configuration/prepared-rules-response'
import { type TimeStamp, timeStampNow } from '../time'
import { DependencyGraphError, TargetingKeyMissingError } from './errors'
import { evaluateForSubject } from './evaluateForSubject'
import {
  evaluateProtobufConfiguration,
  protobufVariationTypeToFlagValueType,
  type ResolveProtobufFlagEvaluation,
} from './evaluateProtobufConfiguration'
import { createEvaluationMetadata, createEvaluationTimestampMetadata } from './evaluationMetadata'
import {
  acknowledgesExperimentationOptOut,
  type ExperimentationOptOutOption,
  type ExperimentationOptOutPolicy,
  experimentationOptOutPolicy,
  INVALID_EXPERIMENTATION_OPT_OUT,
} from './experimentation-opt-out'
import { evaluatePrecomputedConfiguration } from './precomputed-evaluation'
import type { FlagEvaluation, ResolveFlagEvaluation } from './rules'
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
  experimentationOptOutMode: ExperimentationOptOutOption = false
): ResolutionDetails<FlagTypeToValue<T>> {
  const selection = selectFlagsConfiguration(flagsConfiguration, context, experimentationOptOutMode)
  if (selection.kind === 'precomputed') {
    return evaluatePrecomputedConfiguration(
      flagsConfiguration,
      type,
      flagKey,
      defaultValue,
      context,
      experimentationOptOutMode,
      logger
    )
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
    (!optedOut || configuration.precomputed.context !== undefined) &&
    acknowledgesExperimentationOptOut(configuration, optedOut)
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
  return evaluateRulesBasedConfigurationWithTrace(
    config,
    type,
    flagKey,
    defaultValue,
    context,
    logger,
    experimentationOptOutMode,
    { collectDependencyEvaluations: false, collectDependencyExposures: false }
  ).details
}

export type EvaluationTrace<T extends FlagValue = FlagValue> = {
  details: ResolutionDetails<T>
  dependencyEvaluations: readonly DependencyEvaluation[]
  dependencyExposures: readonly DependencyExposureCandidate[]
}

export type EvaluationTraceOptions = {
  collectDependencyEvaluations?: boolean
  collectDependencyExposures?: boolean
}

/** @internal Returns the completed dependency trace for provider integrations. */
export function evaluateRulesBasedConfigurationWithTrace<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  experimentationOptOutMode: ExperimentationOptOutOption = false,
  options: EvaluationTraceOptions = {}
): EvaluationTrace<FlagTypeToValue<T>> {
  const evaluationTimestampMs = timeStampNow()
  // Snapshot consent once at the start of this evaluation. The provider can receive a new
  // configuration later, but hooks must see the consent from the configuration that produced this result.
  const observeFullEvaluationData = config?.observeFullEvaluationData === true
  const metadata = createEvaluationMetadata(evaluationTimestampMs, observeFullEvaluationData)
  const excludeExperiments = experimentationOptOutPolicy(context, experimentationOptOutMode)
  if (excludeExperiments === undefined) {
    return {
      details: {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'INVALID_CONTEXT' as ErrorCode,
        errorMessage: INVALID_EXPERIMENTATION_OPT_OUT,
        flagMetadata: metadata,
      },
      dependencyEvaluations: [],
      dependencyExposures: [],
    }
  }
  let trace: EvaluationTrace<FlagTypeToValue<T>>
  try {
    trace = evaluateRules(
      config,
      type,
      flagKey,
      defaultValue,
      context,
      logger,
      evaluationTimestampMs,
      excludeExperiments,
      observeFullEvaluationData,
      options.collectDependencyEvaluations !== false,
      options.collectDependencyExposures !== false
    )
  } catch (error) {
    logger.error('Error evaluating flag', { error })
    trace = {
      details: { value: defaultValue, reason: 'ERROR', errorCode: 'GENERAL' as ErrorCode },
      dependencyEvaluations: [],
      dependencyExposures: [],
    }
  }
  return {
    ...trace,
    details: { ...trace.details, flagMetadata: { ...trace.details.flagMetadata, ...metadata } },
  }
}

function evaluateRules<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
  evaluationTimestampMs: TimeStamp,
  excludeExperiments: ExperimentationOptOutPolicy,
  observeFullEvaluationData: boolean,
  collectDependencyEvaluations: boolean,
  collectDependencyExposures: boolean
): EvaluationTrace<FlagTypeToValue<T>> {
  if (!config) {
    return {
      details: {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      },
      dependencyEvaluations: [],
      dependencyExposures: [],
    }
  }

  if (isProtobufConfiguration(config)) {
    const prepared = prepareRulesResponse(config)
    const dependencies = createProtobufDependencyResolver(
      prepared,
      flagKey,
      context,
      logger,
      evaluationTimestampMs,
      excludeExperiments,
      observeFullEvaluationData,
      collectDependencyExposures,
      collectDependencyEvaluations
    )
    let details: ResolutionDetails<FlagTypeToValue<T>>
    try {
      details = evaluateProtobufConfiguration(
        prepared,
        type,
        flagKey,
        defaultValue,
        context,
        logger,
        evaluationTimestampMs,
        excludeExperiments,
        dependencies.resolve
      )
    } catch (error) {
      if (error instanceof DependencyGraphError) {
        details = dependencyGraphFailure(error, defaultValue, logger, evaluationTimestampMs)
      } else {
        logger.error('Error evaluating flag', { error })
        details = {
          value: defaultValue,
          reason: 'ERROR',
          errorCode: 'GENERAL' as ErrorCode,
          flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
        }
      }
    }
    return dependencies.complete(details)
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
      details: {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      },
      dependencyEvaluations: [],
      dependencyExposures: [],
    }
  }

  let dependencySession: DependencyEvaluationSession | undefined
  let details: ResolutionDetails<FlagTypeToValue<T>>
  try {
    const createDependencySession = (maxDependencyDepth: number) =>
      new DependencyEvaluationSession(
        flagKey,
        maxDependencyDepth,
        observeFullEvaluationData,
        (key) => {
          if (!Object.prototype.hasOwnProperty.call(config.flags, key)) return undefined
          return jsonDependencyFlag(config.flags[key])
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
            excludeExperiments,
            asFlagEvaluationResolver(resolveFlagEvaluation)
          ) as ResolutionDetails<FlagValue>,
        logger,
        evaluationTimestampMs,
        collectDependencyExposures,
        collectDependencyEvaluations
      )
    const resolveDependency = ((flagEvaluation: FlagEvaluation) => {
      dependencySession ??= createDependencySession(getMaxDependencyDepth(config, flagKey, logger))
      return dependencySession.resolveFlagEvaluation(flagEvaluation, 1)
    }) as ResolveFlagEvaluation
    resolveDependency.checkpoint = () => dependencySession?.checkpoint()
    resolveDependency.rollback = (checkpoint) => dependencySession?.rollback(checkpoint)
    const evaluated = evaluateForSubject(
      config.flags[flagKey],
      type,
      subjectKey,
      subjectAttributes,
      defaultValue,
      logger,
      evaluationTimestampMs,
      excludeExperiments,
      resolveDependency
    )
    details = {
      ...evaluated,
      flagMetadata: {
        ...evaluated.flagMetadata,
        ...createEvaluationMetadata(evaluationTimestampMs, observeFullEvaluationData),
      },
    }
  } catch (error) {
    if (error instanceof TargetingKeyMissingError) {
      details = {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'TARGETING_KEY_MISSING' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    } else if (error instanceof DependencyGraphError) {
      details = dependencyGraphFailure(error, defaultValue, logger, evaluationTimestampMs)
    } else {
      logger.error('Error evaluating flag', { error })
      details = {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'GENERAL' as ErrorCode,
        flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
      }
    }
  }
  return (
    dependencySession?.complete(details.reason !== 'ERROR' && details.errorCode === undefined, details) ?? {
      details,
      dependencyEvaluations: [],
      dependencyExposures: [],
    }
  )
}

/** Internal shared dependency traversal for typed evaluation and assignment-only precomputation. */
export function createProtobufDependencyResolver(
  config: PreparedRulesResponse,
  flagKey: string,
  context: EvaluationContext,
  logger: Logger,
  evaluationTimestampMs: TimeStamp,
  excludeExperiments: ExperimentationOptOutPolicy,
  observeFullEvaluationData: boolean,
  collectDependencyExposures = false,
  collectDependencyEvaluations = false
) {
  let dependencySession: DependencyEvaluationSession | undefined
  const createDependencySession = (maxDependencyDepth: number) =>
    new DependencyEvaluationSession(
      flagKey,
      maxDependencyDepth,
      observeFullEvaluationData,
      (key) => {
        const flag = Object.prototype.hasOwnProperty.call(config.flags, key) ? config.flags[key] : undefined
        if (flag === undefined) return undefined
        return protobufDependencyFlag(flag)
      },
      (key, dependencyType, dependencyDefault, resolveFlagEvaluation) =>
        evaluateProtobufConfiguration(
          config,
          dependencyType,
          key,
          dependencyDefault,
          context,
          logger,
          evaluationTimestampMs,
          excludeExperiments,
          resolveFlagEvaluation
        ),
      logger,
      evaluationTimestampMs,
      collectDependencyExposures,
      collectDependencyEvaluations
    )
  const resolve = ((dependencyFlagKey: string) => {
    dependencySession ??= createDependencySession(getMaxDependencyDepth(config, flagKey, logger))
    return dependencySession.resolveFlagEvaluation(dependencyFlagKey, 1)
  }) as ResolveProtobufFlagEvaluation
  // Hook presence tells the protobuf evaluator to retain and replay dependency keys.
  if (collectDependencyExposures) {
    resolve.checkpoint = () => dependencySession?.checkpoint()
    resolve.rollback = (checkpoint) => dependencySession?.rollback(checkpoint)
  }
  return {
    resolve,
    complete<T extends FlagValue>(details: ResolutionDetails<T>): EvaluationTrace<T> {
      return (
        dependencySession?.complete(details.reason !== 'ERROR' && details.errorCode === undefined, details) ?? {
          details,
          dependencyEvaluations: [],
          dependencyExposures: [],
        }
      )
    },
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
    errorCode: error.rootErrorCode,
    errorMessage: error.rootErrorMessage,
    flagMetadata: createEvaluationTimestampMetadata(evaluationTimestampMs),
  }
}

export type DependencyEvaluation = {
  flagKey: string
  details: Omit<ResolutionDetails<FlagValue>, 'value'> & { value?: FlagValue }
}

export type DependencyExposureCandidate = {
  flagKey: string
  details: Omit<ResolutionDetails<FlagValue>, 'value'>
}

class DependencyEvaluationSession {
  private readonly memo = new Map<string, MemoizedDependency>()
  private readonly active: Set<string>
  private readonly frames: DependencyEvaluationFrame[] = []
  private readonly evaluations: DependencyEvaluation[] = []
  private readonly evaluationKeys = new Set<string>()
  private readonly exposures: DependencyExposureCandidate[] | undefined
  private readonly exposureKeys: Set<string> | undefined

  constructor(
    rootFlagKey: string,
    private readonly maxDependencyDepth: number,
    private readonly observeFullEvaluationData: boolean,
    private readonly getFlag: (flagKey: string) => DependencyFlag | undefined,
    private readonly evaluateFlag: DependencyFlagEvaluator,
    private readonly logger: Logger,
    private readonly evaluationTimestampMs: TimeStamp,
    collectDependencyExposures: boolean,
    private readonly collectDependencyEvaluations: boolean
  ) {
    this.active = new Set([rootFlagKey])
    this.exposures = collectDependencyExposures ? [] : undefined
    this.exposureKeys = collectDependencyExposures ? new Set() : undefined
  }

  complete<T extends FlagValue>(commitExposures: boolean, details: ResolutionDetails<T>): EvaluationTrace<T> {
    return {
      details,
      dependencyEvaluations: this.evaluations,
      dependencyExposures: commitExposures && this.exposures !== undefined ? this.exposures : [],
    }
  }

  checkpoint(): DependencyExposureCheckpoint | undefined {
    if (this.exposures === undefined) {
      return undefined
    }
    const frame = this.frames[this.frames.length - 1]
    return {
      exposureCount: this.exposures.length,
      ...(frame?.exposureTrace === undefined ? {} : { frameExposureCount: frame.exposureTrace.length }),
    }
  }

  rollback(checkpoint: unknown): void {
    if (this.exposures === undefined) {
      return
    }
    const resolved = isDependencyExposureCheckpoint(checkpoint)
      ? checkpoint
      : { exposureCount: 0, frameExposureCount: undefined }
    truncateDependencyExposureTrace(this.exposures, this.exposureKeys!, resolved.exposureCount)
    const frame = this.frames[this.frames.length - 1]
    if (frame?.exposureTrace !== undefined && resolved.frameExposureCount !== undefined) {
      truncateDependencyExposureTrace(frame.exposureTrace, frame.exposureKeys!, resolved.frameExposureCount)
    }
  }

  private evaluate(flagKey: string, depth: number): MemoizedDependency {
    const memoized = this.memo.get(flagKey)
    if (memoized !== undefined) {
      if (depth + memoized.descendantDepth > this.maxDependencyDepth) {
        this.logger.debug('maximum flag dependency depth exceeded', {
          flagKey,
          maxDependencyDepth: this.maxDependencyDepth,
        })
        throw new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'maximum flag dependency depth exceeded')
      }
      return memoized
    }

    const flag = this.getFlag(flagKey)
    if (flag === undefined) {
      this.logger.debug('prerequisite flag is missing', { flagKey })
      this.recordMissingFlagEvaluation(flagKey)
      throw new DependencyGraphError(flagKey, 'FLAG_NOT_FOUND' as ErrorCode, 'prerequisite flag is missing')
    }

    const { type, defaultValue } = flag

    this.active.add(flagKey)
    const frame: DependencyEvaluationFrame = {
      maxReachedDepth: depth,
      ...(this.exposures === undefined ? {} : { exposureTrace: [], exposureKeys: new Set<string>() }),
    }
    this.frames.push(frame)
    try {
      const evaluated = this.evaluateFlag(flagKey, type, defaultValue, this.resolverAtDepth(depth + 1))
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
      if (frame.exposureTrace !== undefined) {
        appendDependencyExposureUnique(frame.exposureTrace, frame.exposureKeys!, {
          flagKey,
          details: withoutValue(result),
        })
      }
      const exposureTrace = frame.exposureTrace
      const memoizedResult: MemoizedDependency = {
        details: result,
        descendantDepth: frame.maxReachedDepth - depth,
        ...(exposureTrace === undefined ? {} : { exposureTrace }),
      }
      this.memo.set(flagKey, memoizedResult)
      const evaluation = { flagKey, details: result }
      this.recordEvaluation(evaluation)
      return memoizedResult
    } catch (error) {
      const graphError = this.toDependencyGraphError(flagKey, error)
      const isOriginatingFailure = graphError.flagKey === flagKey
      this.recordEvaluation({
        flagKey,
        details: {
          value: defaultValue,
          reason: 'ERROR',
          errorCode: isOriginatingFailure ? graphError.errorCode : ('GENERAL' as ErrorCode),
          errorMessage: isOriginatingFailure ? graphError.message : graphError.rootErrorMessage,
          flagMetadata: createEvaluationMetadata(this.evaluationTimestampMs, this.observeFullEvaluationData),
        },
      })
      throw graphError
    } finally {
      this.frames.pop()
      this.active.delete(flagKey)
    }
  }

  resolveFlagEvaluation(flagEvaluation: FlagEvaluation | string, depth: number): string | undefined {
    const flagKey = typeof flagEvaluation === 'string' ? flagEvaluation : flagEvaluation.key
    if (depth > this.maxDependencyDepth) {
      this.logger.debug('maximum flag dependency depth exceeded', {
        flagKey,
        maxDependencyDepth: this.maxDependencyDepth,
      })
      if (!this.memo.has(flagKey) && !this.active.has(flagKey)) {
        this.recordEvaluation({
          flagKey,
          details: {
            reason: 'ERROR',
            errorCode: 'GENERAL' as ErrorCode,
            errorMessage: 'maximum flag dependency depth exceeded',
            flagMetadata: createEvaluationMetadata(this.evaluationTimestampMs, this.observeFullEvaluationData),
          },
        })
      }
      throw new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'maximum flag dependency depth exceeded')
    }
    if (this.active.has(flagKey)) {
      this.logger.debug('flag dependency cycle detected', { flagKey })
      throw new DependencyGraphError(flagKey, 'GENERAL' as ErrorCode, 'flag dependency cycle detected')
    }

    const result = this.evaluate(flagKey, depth)
    this.recordReachedDepth(depth + result.descendantDepth)
    if (result.exposureTrace !== undefined) {
      this.recordExposureTrace(result.exposureTrace)
    }
    return result.details.variant
  }

  private resolverAtDepth(depth: number): ResolveDependency {
    const resolve = ((flagKey: string) => this.resolveFlagEvaluation(flagKey, depth)) as ResolveDependency
    if (this.exposures !== undefined) {
      resolve.checkpoint = () => this.checkpoint()
      resolve.rollback = (checkpoint) => this.rollback(checkpoint)
    }
    return resolve
  }

  private recordReachedDepth(depth: number): void {
    const frame = this.frames[this.frames.length - 1]
    if (frame !== undefined) {
      frame.maxReachedDepth = Math.max(frame.maxReachedDepth, depth)
    }
  }

  private recordExposureTrace(trace: readonly DependencyExposureCandidate[]): void {
    if (this.exposures === undefined) {
      return
    }
    appendDependencyExposureTrace(this.exposures, this.exposureKeys!, trace)
    const frame = this.frames[this.frames.length - 1]
    if (frame?.exposureTrace !== undefined) {
      appendDependencyExposureTrace(frame.exposureTrace, frame.exposureKeys!, trace)
    }
  }

  private recordEvaluation(evaluation: DependencyEvaluation): void {
    if (!this.collectDependencyEvaluations || this.evaluationKeys.has(evaluation.flagKey)) {
      return
    }
    const { value, flagMetadata, ...evaluationDetails } = evaluation.details
    const details: DependencyEvaluation['details'] = {
      ...evaluationDetails,
      ...(flagMetadata === undefined ? {} : { flagMetadata: { ...flagMetadata } }),
    }
    try {
      if (value !== undefined) details.value = cloneFlagValue(value)
    } catch {
      // Retain status and key when a value cannot be detached. Consumers use
      // this record to reconcile prerequisite failures after evaluation.
    }
    this.evaluations.push({ flagKey: evaluation.flagKey, details })
    this.evaluationKeys.add(evaluation.flagKey)
  }

  private recordMissingFlagEvaluation(flagKey: string): void {
    this.recordEvaluation({
      flagKey,
      details: {
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND' as ErrorCode,
        errorMessage: 'prerequisite flag is missing',
        flagMetadata: createEvaluationMetadata(this.evaluationTimestampMs, this.observeFullEvaluationData),
      },
    })
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
}

function cloneFlagValue(value: FlagValue): FlagValue {
  if (Array.isArray(value)) {
    return value.map(cloneFlagValue)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneFlagValue(child)]))
  }
  return value
}

type DependencyFlag = {
  type: FlagValueType
  defaultValue: FlagValue
}

type MemoizedDependency = {
  details: ResolutionDetails<FlagValue>
  descendantDepth: number
  exposureTrace?: DependencyExposureCandidate[]
}

type DependencyEvaluationFrame = {
  maxReachedDepth: number
  exposureTrace?: DependencyExposureCandidate[]
  exposureKeys?: Set<string>
}

type DependencyExposureCheckpoint = {
  exposureCount: number
  frameExposureCount?: number
}

type ResolveDependency = ((flagKey: string) => string | undefined) & {
  checkpoint?: () => unknown
  rollback?: (checkpoint: unknown) => void
}

type DependencyFlagEvaluator = (
  flagKey: string,
  type: FlagValueType,
  defaultValue: FlagValue,
  resolveFlagEvaluation: ResolveDependency
) => ResolutionDetails<FlagValue>

function isDependencyExposureCheckpoint(value: unknown): value is DependencyExposureCheckpoint {
  return (
    typeof value === 'object' &&
    value !== null &&
    'exposureCount' in value &&
    typeof value.exposureCount === 'number' &&
    (!('frameExposureCount' in value) ||
      value.frameExposureCount === undefined ||
      typeof value.frameExposureCount === 'number')
  )
}

function appendDependencyExposureUnique(
  target: DependencyExposureCandidate[],
  keys: Set<string>,
  candidate: DependencyExposureCandidate
): void {
  if (keys.has(candidate.flagKey)) return
  target.push(candidate)
  keys.add(candidate.flagKey)
}

function withoutValue(details: ResolutionDetails<FlagValue>): Omit<ResolutionDetails<FlagValue>, 'value'> {
  const { value: _value, ...rest } = details
  return rest
}

function appendDependencyExposureTrace(
  target: DependencyExposureCandidate[],
  keys: Set<string>,
  trace: readonly DependencyExposureCandidate[]
): void {
  for (const candidate of trace) {
    appendDependencyExposureUnique(target, keys, candidate)
  }
}

function truncateDependencyExposureTrace(
  target: DependencyExposureCandidate[],
  keys: Set<string>,
  length: number
): void {
  for (const candidate of target.splice(length)) {
    keys.delete(candidate.flagKey)
  }
}

function asFlagEvaluationResolver(resolveDependency: ResolveDependency): ResolveFlagEvaluation {
  const resolve = ((flagEvaluation: FlagEvaluation) => resolveDependency(flagEvaluation.key)) as ResolveFlagEvaluation
  resolve.checkpoint = resolveDependency.checkpoint
  resolve.rollback = resolveDependency.rollback
  return resolve
}

function getMaxDependencyDepth(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration,
  rootFlagKey: string,
  logger: Logger
): number {
  let evaluatorParams: unknown
  try {
    evaluatorParams = config.evaluatorParams
  } catch {
    logInvalidEvaluatorParams(config, logger, rootFlagKey)
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  if (evaluatorParams === undefined) {
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  if (evaluatorParams === null || typeof evaluatorParams !== 'object' || Array.isArray(evaluatorParams)) {
    logInvalidEvaluatorParams(config, logger, rootFlagKey)
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  let configuredDepth: unknown
  try {
    configuredDepth = (evaluatorParams as { maxDependencyDepth?: unknown }).maxDependencyDepth
  } catch {
    logInvalidEvaluatorParams(config, logger, rootFlagKey)
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  if (configuredDepth === undefined) {
    return DEFAULT_MAX_DEPENDENCY_DEPTH
  }
  const numericDepth =
    typeof configuredDepth === 'bigint' && isProtobufConfiguration(config) ? Number(configuredDepth) : configuredDepth
  if (typeof numericDepth === 'number' && Number.isInteger(numericDepth) && numericDepth >= 0 && numericDepth <= 255) {
    return numericDepth
  }
  logInvalidEvaluatorParams(config, logger, rootFlagKey)
  return DEFAULT_MAX_DEPENDENCY_DEPTH
}

const invalidEvaluatorParamsLogged = new WeakSet<object>()

function logInvalidEvaluatorParams(
  config: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration,
  logger: Logger,
  rootFlagKey: string
): void {
  if (invalidEvaluatorParamsLogged.has(config)) return
  invalidEvaluatorParamsLogged.add(config)
  logger.error('invalid evaluatorParams; using default maxDependencyDepth', {
    flagKey: rootFlagKey,
    defaultMaxDependencyDepth: DEFAULT_MAX_DEPENDENCY_DEPTH,
  })
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

function protobufDependencyFlag(flag: ProtobufFlagsConfiguration['flags'][string]): DependencyFlag {
  try {
    const type = protobufVariationTypeToFlagValueType(flag.variationType)
    return { type, defaultValue: defaultValueForType(type) }
  } catch {
    // The evaluator owns descriptor validation and will report PARSE_ERROR with dependency telemetry.
    return { type: 'boolean', defaultValue: false }
  }
}

function jsonDependencyFlag(flag: unknown): DependencyFlag {
  try {
    const type = variantTypeToFlagValueType((flag as Flag).variationType)
    return { type, defaultValue: defaultValueForType(type) }
  } catch {
    // The evaluator owns descriptor validation and will report PARSE_ERROR with dependency telemetry.
    return { type: 'boolean', defaultValue: false }
  }
}

function isProtobufConfiguration(
  configuration: UniversalFlagConfigurationV1 | ProtobufFlagsConfiguration
): configuration is ProtobufFlagsConfiguration {
  return '$typeName' in configuration && configuration.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration'
}
