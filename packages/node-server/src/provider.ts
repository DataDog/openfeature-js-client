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
import { type SDKDiagnostic, SDKDiagnostics } from './sdk-diagnostics'

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
  /** Receives diagnostic observations without awaiting delivery. Omit to disable measurement. */
  onDiagnostic?: (diagnostic: SDKDiagnostic) => void | Promise<void>
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

type StagedDependencyTelemetry = PreparedDependencyTelemetry & {
  rootMetadata: object
  rootContext: object
}

/**
 * Associates a completed dependency trace with the root result's metadata and evaluation context.
 * Evaluation and exposure hooks consume their respective batches from the same root lifecycle.
 * @internal
 */
export class DependencyTelemetrySidecar {
  private readonly batchesByMetadata = new WeakMap<object, StagedDependencyTelemetry>()
  private readonly batchesByContext = new WeakMap<object, StagedDependencyTelemetry>()

  constructor(readonly collectDependencyEvaluations = true) {}

  stage(rootMetadata: object, rootContext: object, telemetry: PreparedDependencyTelemetry): void {
    if (telemetry.dependencyEvaluations.length > 0 || telemetry.dependencyExposures.length > 0) {
      const batch = { ...telemetry, rootMetadata, rootContext }
      this.batchesByMetadata.set(rootMetadata, batch)
      this.batchesByContext.set(rootContext, batch)
    }
  }

  takeDependencyEvaluations(metadata: object | undefined, context?: object): readonly DependencyEvaluation[] {
    const batch = this.getBatch(metadata, context)
    if (batch === undefined) {
      return []
    }
    const evaluations = batch.dependencyEvaluations
    batch.dependencyEvaluations = []
    if (batch.dependencyExposures.length === 0) {
      this.deleteBatch(batch)
    }
    return evaluations
  }

  takeDependencyExposures(metadata: object | undefined): readonly PreparedDependencyExposure[] {
    if (metadata === undefined) {
      return []
    }
    const batch = this.batchesByMetadata.get(metadata)
    if (batch === undefined) {
      return []
    }
    const exposures = batch.dependencyExposures
    batch.dependencyExposures = []
    if (batch.dependencyEvaluations.length === 0) {
      this.deleteBatch(batch)
    }
    return exposures
  }

  discardDependencyExposures(metadata: object | undefined): void {
    if (metadata === undefined) {
      return
    }
    const batch = this.batchesByMetadata.get(metadata)
    if (batch === undefined) {
      return
    }
    batch.dependencyExposures = []
    if (batch.dependencyEvaluations.length === 0) {
      this.deleteBatch(batch)
    }
  }

  private getBatch(metadata: object | undefined, context: object | undefined): StagedDependencyTelemetry | undefined {
    return (
      (metadata === undefined ? undefined : this.batchesByMetadata.get(metadata)) ??
      (context === undefined ? undefined : this.batchesByContext.get(context))
    )
  }

  private deleteBatch(batch: StagedDependencyTelemetry): void {
    if (this.batchesByMetadata.get(batch.rootMetadata) === batch) {
      this.batchesByMetadata.delete(batch.rootMetadata)
    }
    if (this.batchesByContext.get(batch.rootContext) === batch) {
      this.batchesByContext.delete(batch.rootContext)
    }
  }
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  readonly hooks?: Hook[]

  private initController?: InitializationController
  private readonly diagnostics?: SDKDiagnostics
  private initialization?: Promise<void>
  readonly events: ProviderEventEmitter<ServerProviderEvents>
  private readonly exposureCache: AssignmentCache | undefined
  private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecar

  private configuration?: UniversalFlagConfigurationV1 | undefined
  private readonly experimentationOptOutMode: ExperimentationOptOutMode

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.diagnostics = options.onDiagnostic ? new SDKDiagnostics(options.onDiagnostic) : undefined
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

    this.diagnostics?.configurationReceived()

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
  initialize(): Promise<void> {
    this.diagnostics?.start(this.configuration !== undefined)
    if (this.configuration) {
      this.diagnostics?.finish('ready')
      return Promise.resolve()
    }

    const initialization = this.initializeConfiguration()
    if (this.diagnostics) this.initialization = initialization
    return initialization
  }

  private async initializeConfiguration(): Promise<void> {
    const timeoutMs = this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    this.initController = new InitializationController(timeoutMs, () =>
      this.setError(new Error(`Initialization timeout after ${timeoutMs}ms`))
    )

    try {
      await this.initController.wait()
      await this.exposureCache?.init()
      if (!this.configuration) {
        throw new Error('Flag configuration is unavailable')
      }
      this.diagnostics?.finish('ready')
    } catch (error) {
      this.diagnostics?.finish('failed')
      throw error
    } finally {
      this.initialization = undefined
    }
  }

  /** Called by the integration once before a sequential configuration poll, including its retries. */
  reportConfigurationFetchStart(): void {
    this.diagnostics?.fetchStarted()
  }

  /** Called after the poll succeeds or exhausts retries; cancellations are not fetch failures. */
  reportConfigurationFetchResult(success: boolean): void {
    this.diagnostics?.fetchResult(success)
  }

  async onClose(): Promise<void> {
    const diagnostics = this.diagnostics
    if (!diagnostics) return
    if (this.initialization && !this.initController?.isInitializing()) {
      // Configuration or an error arrived. Let initialization finish, including cache setup,
      // before closing diagnostics so a same-turn close preserves the actual outcome.
      try {
        await this.initialization
      } catch {
        // The initialization caller still receives the original rejection.
      }
    }
    diagnostics.close()
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
      const details = {
        ...evaluation.details,
        flagKey: evaluation.flagKey,
        flagMetadata: (evaluation.details.flagMetadata ?? {}) as FlagMetadata,
      }
      const exposure = this.prepareExposure(context, details)
      if (exposure !== undefined) prepared.push(exposure)
    }
    this.dependencyTelemetrySidecar.stage(rootMetadata, context, {
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
    this.prepareExposure(context, {
      flagKey,
      variant: resolutionDetails.variant,
      flagMetadata: (resolutionDetails.flagMetadata ?? {}) as FlagMetadata,
    })
  }

  private prepareExposure(
    context: EvaluationContext,
    details: PreparedDependencyExposure['details']
  ): PreparedDependencyExposure | undefined {
    try {
      const event = createExposureEvent(context, details)
      if (event === undefined) return
      if (this.exposureCache) prepareExposureDecision(details.flagMetadata, this.exposureCache, event)
      return { details, event }
    } catch {
      // Exposure preparation is best effort and must not affect assignment or evaluation telemetry.
      return
    }
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
  }

  error(hookContext: Readonly<HookContext<FlagValue>>): void {
    const evaluationDetails = this.pending.get(hookContext)
    const metadata = evaluationDetails?.flagMetadata
    // A later hook failure rolls back transactional exposures, but dependency
    // evaluation telemetry remains observable from the root finally lifecycle.
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
        // Never publish caller-owned objects. If structured cloning rejects an
        // unsupported value, fall back to a detached JSON-safe snapshot.
        const telemetryExposure = cloneForTelemetry(exposure)
        if (telemetryExposure !== undefined) this.exposureChannel.publish(telemetryExposure)
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
    try {
      const fallback = cloneTelemetryValue(value, new WeakSet())
      return fallback === unsupportedTelemetryValue ? undefined : (fallback as T)
    } catch {
      // Telemetry is best effort and must not affect flag evaluation semantics.
      return undefined
    }
  }
}

const unsupportedTelemetryValue = Symbol('unsupported telemetry value')

function cloneTelemetryValue(value: unknown, seen: WeakSet<object>): unknown | typeof unsupportedTelemetryValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value !== 'object' || seen.has(value)) return unsupportedTelemetryValue

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = []
      for (const entry of value) {
        const clonedEntry = cloneTelemetryValue(entry, seen)
        if (clonedEntry !== unsupportedTelemetryValue) clone.push(clonedEntry)
      }
      return clone
    }

    const clone: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      let entry: unknown
      try {
        entry = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const clonedEntry = cloneTelemetryValue(entry, seen)
      if (clonedEntry !== unsupportedTelemetryValue) {
        Object.defineProperty(clone, key, { value: clonedEntry, enumerable: true, configurable: true, writable: true })
      }
    }
    return clone
  } finally {
    seen.delete(value)
  }
}
