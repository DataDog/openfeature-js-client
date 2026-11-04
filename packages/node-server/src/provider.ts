import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  completeExposureDecision,
  createExposureEvent,
  type DependencyEvaluation,
  type DependencyExposureCandidate,
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
import { evaluateWithTrace } from './configuration/evaluation'
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
   * Internal sidecar consumed by the integration's root evaluation hook.
   * @internal
   */
  dependencyTelemetrySidecar?: DependencyTelemetrySidecar
  /**
   * Timeout in milliseconds for provider initialization.
   * If the configuration is not set within this time, initialization will fail.
   * @default DEFAULT_INITIALIZATION_TIMEOUT_MS (30000ms / 30 seconds)
   */
  initializationTimeoutMs?: number
  /** Experiment exclusion policy. Defaults to Disabled; environment configuration belongs to the caller. */
  experimentationOptOutMode?: ExperimentationOptOutMode
}

type PreparedDependencyExposure = {
  details: Omit<EvaluationDetails<FlagValue>, 'value'> & { value?: FlagValue }
  event: ExposureEvent
}

type PreparedDependencyTelemetry = {
  dependencyEvaluations: readonly DependencyEvaluation[]
  dependencyExposures: readonly PreparedDependencyExposure[]
}

/**
 * Associates a completed dependency trace with the root result's metadata object.
 * Evaluation and exposure hooks consume their respective batches from the same root lifecycle.
 * @internal
 */
export class DependencyTelemetrySidecar {
  private readonly batches = new WeakMap<object, PreparedDependencyTelemetry>()
  private readonly evaluationAliases = new WeakMap<object, PreparedDependencyTelemetry>()

  constructor(readonly collectDependencyEvaluations = true) {}

  stage(rootMetadata: object, telemetry: PreparedDependencyTelemetry): void {
    if (telemetry.dependencyEvaluations.length > 0 || telemetry.dependencyExposures.length > 0) {
      this.batches.set(rootMetadata, telemetry)
    }
  }

  associateDependencyEvaluations(alias: object, metadata: object | undefined): void {
    const batch = metadata === undefined ? undefined : this.batches.get(metadata)
    if (batch !== undefined && batch.dependencyEvaluations.length > 0) {
      this.evaluationAliases.set(alias, batch)
    }
  }

  takeDependencyEvaluations(
    metadata: object | undefined,
    alias?: object
  ): readonly DependencyEvaluation[] {
    const batch =
      (metadata === undefined ? undefined : this.batches.get(metadata)) ??
      (alias === undefined ? undefined : this.evaluationAliases.get(alias))
    if (batch === undefined) {
      return []
    }
    if (alias !== undefined) this.evaluationAliases.delete(alias)
    const evaluations = batch.dependencyEvaluations
    batch.dependencyEvaluations = []
    if (metadata !== undefined && batch.dependencyExposures.length === 0) {
      this.batches.delete(metadata)
    }
    return evaluations
  }

  takeDependencyExposures(metadata: object | undefined): readonly PreparedDependencyExposure[] {
    if (metadata === undefined) {
      return []
    }
    const exposures = this.batches.get(metadata)?.dependencyExposures ?? []
    this.batches.delete(metadata)
    return exposures
  }

  discard(metadata: object | undefined): void {
    if (metadata !== undefined) {
      this.batches.delete(metadata)
    }
  }

  discardDependencyExposures(metadata: object | undefined): void {
    if (metadata === undefined) return
    const batch = this.batches.get(metadata)
    if (batch === undefined) return
    batch.dependencyExposures = []
    if (batch.dependencyEvaluations.length === 0) this.batches.delete(metadata)
  }
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
  private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecar

  private configuration?: UniversalFlagConfigurationV1 | undefined
  private readonly experimentationOptOutMode: ExperimentationOptOutMode

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.experimentationOptOutMode = resolveExperimentationOptOutMode(options.experimentationOptOutMode)
    this.hooks = []
    this.events = new NodeProviderEventEmitter()
    this.exposureCache = new LRUInMemoryAssignmentCache(50_000)
    this.dependencyTelemetrySidecar = options.dependencyTelemetrySidecar ?? new DependencyTelemetrySidecar(false)
    this.hooks.push(
      // Runs in the final hook stage, where the SDK has turned any later hook error
      // into an error result, so a failed evaluation is never published or recorded.
      new ExposureLoggingHook(this.exposureCache, this.options.exposureChannel, this.dependencyTelemetrySidecar)
    )
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
    const trace = evaluateWithTrace(
      this.configuration,
      'boolean',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode,
      { collectDependencyEvaluations: this.dependencyTelemetrySidecar.collectDependencyEvaluations }
    )
    this.stageDependencyTelemetry(context, trace.details, trace.dependencyEvaluations, trace.dependencyExposures)
    this.handleExposure(flagKey, context, trace.details)
    return trace.details
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    const trace = evaluateWithTrace(
      this.configuration,
      'string',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode,
      { collectDependencyEvaluations: this.dependencyTelemetrySidecar.collectDependencyEvaluations }
    )
    this.stageDependencyTelemetry(context, trace.details, trace.dependencyEvaluations, trace.dependencyExposures)
    this.handleExposure(flagKey, context, trace.details)
    return trace.details
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    const trace = evaluateWithTrace(
      this.configuration,
      'number',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode,
      { collectDependencyEvaluations: this.dependencyTelemetrySidecar.collectDependencyEvaluations }
    )
    this.stageDependencyTelemetry(context, trace.details, trace.dependencyEvaluations, trace.dependencyExposures)
    this.handleExposure(flagKey, context, trace.details)
    return trace.details
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
    const trace = evaluateWithTrace(
      this.configuration,
      'object',
      flagKey,
      defaultValue,
      context,
      _logger,
      this.experimentationOptOutMode,
      { collectDependencyEvaluations: this.dependencyTelemetrySidecar.collectDependencyEvaluations }
    )
    const resolutionDetails = trace.details as ResolutionDetails<T>
    this.stageDependencyTelemetry(context, resolutionDetails, trace.dependencyEvaluations, trace.dependencyExposures)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  private stageDependencyTelemetry(
    context: EvaluationContext,
    rootDetails: ResolutionDetails<FlagValue>,
    dependencyEvaluations: readonly DependencyEvaluation[],
    exposureCandidates: readonly DependencyExposureCandidate[]
  ): void {
    const rootMetadata = rootDetails.flagMetadata
    if (rootMetadata === undefined) {
      return
    }
    const prepared: PreparedDependencyExposure[] = []
    for (const evaluation of exposureCandidates) {
      const metadata = (evaluation.details.flagMetadata ?? {}) as FlagMetadata
      const details = {
        ...evaluation.details,
        flagKey: evaluation.flagKey,
        flagMetadata: metadata,
      }
      const event = createExposureEvent(context, details)
      if (event === undefined) {
        continue
      }
      if (this.exposureCache) prepareExposureDecision(metadata, this.exposureCache, event)
      prepared.push({ details, event })
    }
    this.dependencyTelemetrySidecar.stage(rootMetadata, {
      dependencyEvaluations,
      dependencyExposures: prepared,
    })
  }

  /** Prepares a verdict finalized by the provider hook after successful evaluation. */
  private handleExposure<T extends FlagValue>(
    flagKey: string,
    context: EvaluationContext,
    resolutionDetails: Omit<ResolutionDetails<T>, 'value'> & { value?: T }
  ): void {
    const metadata = (resolutionDetails.flagMetadata ?? {}) as FlagMetadata
    const exposureEvent = createExposureEvent(context, {
      flagKey,
      variant: resolutionDetails.variant,
      flagMetadata: resolutionDetails.flagMetadata ?? {},
    })
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
    private readonly exposureChannel: Channel<ExposureEvent>,
    private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecar
  ) {}

  after(hookContext: Readonly<HookContext<FlagValue>>, evaluationDetails: EvaluationDetails<FlagValue>): void {
    this.pending.set(hookContext, evaluationDetails)
    this.dependencyTelemetrySidecar.associateDependencyEvaluations(hookContext, evaluationDetails.flagMetadata)
  }

  error(hookContext: Readonly<HookContext<FlagValue>>): void {
    const evaluationDetails = this.pending.get(hookContext)
    const metadata = evaluationDetails?.flagMetadata
    this.dependencyTelemetrySidecar.discardDependencyExposures(metadata)
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
    const metadata = evaluationDetails.flagMetadata as FlagMetadata | undefined
    if (metadata !== undefined) {
      const dependencyExposures = this.dependencyTelemetrySidecar.takeDependencyExposures(metadata)
      for (const dependencyExposure of dependencyExposures) {
        this.completeExposure(dependencyExposure.details, dependencyExposure.event)
      }
    }
    const details: EvaluationDetails<FlagValue> = {
      ...evaluationDetails,
      flagKey: evaluationDetails.flagKey ?? hookContext?.flagKey ?? '',
    }
    const exposureEvent = createExposureEvent(hookContext?.context ?? {}, details)
    if (exposureEvent !== undefined) {
      this.completeExposure(details, exposureEvent)
    }
  }

  private completeExposure(
    details: Omit<EvaluationDetails<FlagValue>, 'value'> & { value?: FlagValue },
    exposureEvent: ExposureEvent
  ): void {
    // One check-and-record after successful finalization; concurrent or nested
    // evaluations of the same assignment cannot both be admitted.
    const sharedDecision = completeExposureDecision(details)
    const metadata = details.flagMetadata as FlagMetadata | undefined
    if (metadata?.__dd_do_log !== true || metadata.__dd_exposure_cache_hit !== false) {
      return
    }
    try {
      if (this.exposureChannel.hasSubscribers) {
        // Features stay off the cache entry: a features change must not turn a
        // repeat exposure into a new one.
        const features = featuresWithPrefix(metadata, METADATA_EXPOSURE_FEATURE_PREFIX)
        const exposure = {
          ...exposureEvent,
          ...(features && { features }),
          timestamp: timeStampNow(),
        }
        // Cache admission does not depend on publication, so a failed defensive
        // snapshot must not suppress the only exposure for this assignment.
        this.exposureChannel.publish(cloneForTelemetry(exposure) ?? exposure)
      }
      if (!sharedDecision) this.exposureCache?.set(exposureEvent)
    } catch {
      // Exposure reporting must never break the evaluation.
    }
  }
}

function cloneForTelemetry<T>(value: T): T | undefined {
  try {
    return structuredClone(value)
  } catch {
    // Telemetry is best effort and must not affect flag evaluation semantics.
    return undefined
  }
}
