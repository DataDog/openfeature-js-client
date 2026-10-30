import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  completeExposureDecision,
  createExposureEvent,
  type ExposureEvent,
  featuresWithPrefix,
  LRUInMemoryAssignmentCache,
  METADATA_EXPOSURE_FEATURE_PREFIX,
  prepareExposureDecision,
  prepareUniversalFlagConfiguration,
  timeStampNow,
} from '@datadog/flagging-core'
import type { EvaluationContext, FlagMetadata, ServerProviderEvents } from '@openfeature/core'
import type {
  EvaluationDetails,
  FlagValue,
  Hook,
  HookContext,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderEventEmitter,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/server-sdk'
import { evaluate } from './configuration/evaluation'
import type { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'
import { type ExperimentationOptOutMode, resolveExperimentationOptOutMode } from './experimentation-opt-out'
import { InitializationController } from './initialization-controller'
import { NodeProviderEventEmitter } from './provider-event-emitter'

const PROVIDER_EVENTS = {
  ConfigurationChanged: 'PROVIDER_CONFIGURATION_CHANGED' as ServerProviderEvents.ConfigurationChanged,
  Error: 'PROVIDER_ERROR' as ServerProviderEvents.Error,
  Ready: 'PROVIDER_READY' as ServerProviderEvents.Ready,
}

/**
 * Default timeout in milliseconds for provider initialization.
 */
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000

export interface DatadogNodeServerProviderOptions {
  /**
   * Log experiment exposures
   */
  exposureChannel: Channel<ExposureEvent>
  /**
   * Timeout in milliseconds for provider initialization.
   * If the configuration is not set within this time, initialization will fail.
   * @default DEFAULT_INITIALIZATION_TIMEOUT_MS (30000ms / 30 seconds)
   */
  initializationTimeoutMs?: number
  /** Experiment exclusion policy. Defaults to Disabled; environment configuration belongs to the caller. */
  experimentationOptOutMode?: ExperimentationOptOutMode
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  readonly hooks?: Hook[]

  private initController?: InitializationController
  readonly events: ProviderEventEmitter<ServerProviderEvents>
  private readonly exposureCache: AssignmentCache | undefined

  private configuration?: UniversalFlagConfigurationV1 | undefined
  private readonly experimentationOptOutMode: ExperimentationOptOutMode

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.experimentationOptOutMode = resolveExperimentationOptOutMode(options.experimentationOptOutMode)
    this.hooks = []
    this.events = new NodeProviderEventEmitter()
    this.exposureCache = new LRUInMemoryAssignmentCache(50_000)
    // Runs in the final hook stage, where the SDK has turned any later hook error
    // into an error result, so a failed evaluation is never published or recorded.
    this.hooks.push(new ExposureLoggingHook(this.exposureCache, this.options.exposureChannel))
  }

  /**
   * Used by dd-source-js
   */
  getConfiguration() {
    return this.configuration
  }

  /**
   * Used by dd-source-js. Pass null or undefined to withdraw the configuration.
   */
  setConfiguration(configuration: UniversalFlagConfigurationV1 | null | undefined) {
    if (configuration) {
      prepareUniversalFlagConfiguration(configuration)
    }
    const previousConfiguration = this.configuration
    const prevCreatedAt = this.configuration?.createdAt
    const hadConfiguration = !!this.configuration
    this.configuration = configuration ?? undefined

    if (!configuration) {
      if (hadConfiguration) {
        this.exposureCache?.clear()
        this.setError(new Error('Flag configuration is unavailable'))
      }
      return
    }

    if (hadConfiguration && previousConfiguration !== configuration) {
      if (prevCreatedAt !== configuration.createdAt) {
        this.exposureCache?.clear()
      }
      this.events.emit(PROVIDER_EVENTS.ConfigurationChanged)
      return
    }

    if (this.initController?.isInitializing()) {
      // First configuration during initialization - resolve the initialization promise
      // This will cause OpenFeature SDK to emit PROVIDER_READY
      this.initController.complete()
    } else if (!hadConfiguration) {
      // Configuration is being set after initialization completed/failed (e.g., after timeout)
      // Emit PROVIDER_READY to signal recovery from error state
      this.events.emit(PROVIDER_EVENTS.Ready)
    }
  }

  /**
   * Used by dd-source-js
   */
  setError(error: unknown) {
    if (this.initController?.isInitializing()) {
      this.initController.fail(error)
    } else {
      this.events.emit(PROVIDER_EVENTS.Error, { error })
    }
  }

  /**
   * Used by the OpenFeature SDK to set the status based on initialization.
   * Status of 'PROVIDER_READY' is emitted with a resolved promise.
   * Status of 'PROVIDER_ERROR' is emitted with a rejected promise.
   *
   * Since we aren't loading the configuration in this Provider, we will simulate
   * loading functionality via InitializationController.
   * See setConfiguration and setError for more details.
   */
  async initialize(): Promise<void> {
    if (this.configuration) {
      return
    }

    const timeoutMs = this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    this.initController = new InitializationController(timeoutMs, () =>
      this.setError(new Error(`Initialization timeout after ${timeoutMs}ms`))
    )

    await this.initController.wait()
    await this.exposureCache?.init()
    if (!this.configuration) {
      throw new Error('Flag configuration is unavailable')
    }
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    const resolutionDetails = evaluate(
      this.configuration,
      'boolean',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode
    )
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    const resolutionDetails = evaluate(
      this.configuration,
      'string',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode
    )
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    const resolutionDetails = evaluate(
      this.configuration,
      'number',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode
    )
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<T>> {
    // type safety: OpenFeature interface requires us to return a
    // specific T for *any* value of T (which could be any subtype of
    // JsonValue). We can't even theoretically implement it in a
    // type-sound way because there's no runtime information passed to
    // learn what type the user expects. So it's up to the user to
    // make sure they pass the appropriate type.
    const resolutionDetails = evaluate(
      this.configuration,
      'object',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode
    ) as ResolutionDetails<T>
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  /** Prepares a verdict finalized by the provider hook after successful evaluation. */
  private handleExposure<T extends FlagValue>(
    flagKey: string,
    context: EvaluationContext,
    resolutionDetails: ResolutionDetails<T>
  ): void {
    const metadata = (resolutionDetails.flagMetadata ?? {}) as FlagMetadata
    const evalutationDetails: EvaluationDetails<T> = {
      ...resolutionDetails,
      flagKey: flagKey,
      flagMetadata: metadata,
    }
    const exposureEvent = createExposureEvent(context, evalutationDetails)
    if (!exposureEvent) {
      return
    }
    if (this.exposureCache) prepareExposureDecision(metadata, this.exposureCache, exposureEvent)
  }
}

/**
 * Publishes and records the exposure once the evaluation has completed without an
 * error. A cache entry is written even when nothing subscribes to the exposure
 * channel, so the verdict stays correct with Datadog exposure logging off.
 */
class ExposureLoggingHook implements Hook {
  private readonly pending = new WeakMap<Readonly<HookContext<FlagValue>>, EvaluationDetails<FlagValue>>()

  constructor(
    private readonly exposureCache: AssignmentCache | undefined,
    private readonly exposureChannel: Channel<ExposureEvent>
  ) {}

  after(hookContext: Readonly<HookContext<FlagValue>>, evaluationDetails: EvaluationDetails<FlagValue>): void {
    this.pending.set(hookContext, evaluationDetails)
  }

  error(hookContext: Readonly<HookContext<FlagValue>>): void {
    this.pending.delete(hookContext)
  }

  finally(hookContext: Readonly<HookContext<FlagValue>>): void {
    // Older supported OpenFeature versions pass only hook hints to finally.
    // Capture the successful result in after and discard it on any later error.
    const evaluationDetails = this.pending.get(hookContext)
    this.pending.delete(hookContext)
    if (evaluationDetails == null || evaluationDetails.errorCode !== undefined) {
      return
    }
    // One check-and-record after successful finalization; concurrent or nested
    // evaluations of the same assignment cannot both be admitted.
    const sharedDecision = completeExposureDecision(evaluationDetails)
    const metadata = evaluationDetails.flagMetadata as FlagMetadata | undefined
    if (metadata?.__dd_do_log !== true || metadata.__dd_exposure_cache_hit !== false) {
      return
    }
    try {
      const details: EvaluationDetails<FlagValue> = {
        ...evaluationDetails,
        flagKey: evaluationDetails.flagKey ?? hookContext?.flagKey ?? '',
      }
      const exposureEvent = createExposureEvent(hookContext?.context ?? {}, details)
      if (!exposureEvent) {
        return
      }
      if (this.exposureChannel.hasSubscribers) {
        // Features stay off the cache entry: a features change must not turn a
        // repeat exposure into a new one.
        const features = featuresWithPrefix(metadata, METADATA_EXPOSURE_FEATURE_PREFIX)
        this.exposureChannel.publish({
          ...exposureEvent,
          ...(features && { features }),
          timestamp: timeStampNow(),
        })
      }
      if (!sharedDecision) this.exposureCache?.set(exposureEvent)
    } catch {
      // Exposure reporting must never break the evaluation.
    }
  }
}
