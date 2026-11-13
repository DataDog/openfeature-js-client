import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  createEvaluationMetadata,
  type ExposureEvent,
  evaluatePrecomputedConfiguration,
  type FlagsConfiguration,
  type FlagTypeToValue,
  LRUInMemoryAssignmentCache,
  timeStampNow,
} from '@datadog/flagging-core'
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
import type {
  EvaluationContext,
  FlagValueType,
  Hook,
  JsonValue,
  Logger,
  Provider,
  ProviderEventEmitter,
  ResolutionDetails,
  ServerProviderEvents,
} from '@openfeature/server-sdk'
import { evaluateWithTrace } from './configuration/evaluation'
import { type ExperimentationOptOutMode, resolveExperimentationOptOutMode } from './experimentation-opt-out'
import { NodeProviderEventEmitter } from './provider-event-emitter'
import {
  DependencyTelemetrySidecar,
  type DependencyTelemetrySidecarApi,
  ExposureLoggingHook,
  prepareExposure,
  stageDependencyTelemetry,
} from './tracking'

export interface DatadogCoreProviderOptions {
  /** Experiment exclusion policy. Defaults to Disabled. */
  experimentationOptOutMode?: ExperimentationOptOutMode
  /** Shared with explicitly registered exposure hooks. Does not install a hook or initialize an uploader. @internal */
  exposureCache?: AssignmentCache
  /** Optional exposure sink owned by the tracer integration. Does not initialize an uploader. @internal */
  exposureChannel?: Channel<ExposureEvent>
  /** Consumed by the integration's root evaluation hook. @internal */
  dependencyTelemetrySidecar?: DependencyTelemetrySidecarApi
}

/** Locally initialized provider. Fetching and event delivery are caller-owned. */
export class DatadogCoreProvider implements Provider {
  readonly metadata = { name: 'datadog-core' }
  readonly runsOn = 'server' as const
  readonly hooks: Hook[] = []
  readonly events: ProviderEventEmitter<ServerProviderEvents> = new NodeProviderEventEmitter()
  private configuration: FlagsConfiguration
  private readonly experimentationOptOutMode: ExperimentationOptOutMode
  private readonly exposureCache: AssignmentCache | undefined
  private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecarApi

  // No initialize(): a valid configuration is required before OpenFeature registration.
  constructor(configuration: FlagsConfiguration, options: DatadogCoreProviderOptions = {}) {
    this.experimentationOptOutMode = resolveExperimentationOptOutMode(options.experimentationOptOutMode)
    this.configuration = snapshotConfiguration(configuration)
    this.dependencyTelemetrySidecar = options.dependencyTelemetrySidecar ?? new DependencyTelemetrySidecar(false)
    this.exposureCache = options.exposureCache
    if (options.exposureChannel) {
      this.exposureCache ??= new LRUInMemoryAssignmentCache(50_000)
      this.hooks.push(
        new ExposureLoggingHook(this.exposureCache, options.exposureChannel, this.dependencyTelemetrySidecar)
      )
    }
  }

  /** Return a detached copy; apply replacements with setConfiguration(). */
  getConfiguration(): FlagsConfiguration {
    return snapshotConfiguration(this.configuration)
  }

  /** Validate before replacing the active snapshot. Failure leaves it unchanged. */
  setConfiguration(configuration: FlagsConfiguration): void {
    const next = snapshotConfiguration(configuration)
    const previousGeneration = configurationGeneration(this.configuration)
    this.configuration = next
    if (previousGeneration !== configurationGeneration(next)) {
      this.exposureCache?.clear()
    }
    this.events.emit('PROVIDER_CONFIGURATION_CHANGED' as ServerProviderEvents.ConfigurationChanged)
  }

  async onClose(): Promise<void> {
    this.exposureCache?.clear()
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolve('boolean', flagKey, defaultValue, context, logger)
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger
  ): Promise<ResolutionDetails<string>> {
    return this.resolve('string', flagKey, defaultValue, context, logger)
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger
  ): Promise<ResolutionDetails<number>> {
    return this.resolve('number', flagKey, defaultValue, context, logger)
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger
  ): Promise<ResolutionDetails<T>> {
    const result = this.resolve('object', flagKey, defaultValue, context, logger)
    // Rules cache decoded JSON, and precomputed assignments retain their values. Do not share either between requests.
    return {
      ...result,
      value: result.variant === undefined ? result.value : structuredClone(result.value),
    } as ResolutionDetails<T>
  }

  private resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>> {
    const configuration = this.configuration
    let details: ResolutionDetails<FlagTypeToValue<T>>
    if (configuration.rules) {
      const trace = evaluateWithTrace(
        configuration.rules.response,
        type,
        flagKey,
        defaultValue,
        context,
        logger,
        this.experimentationOptOutMode,
        {
          collectDependencyEvaluations: this.dependencyTelemetrySidecar.collectDependencyEvaluations,
          collectDependencyExposures: this.exposureCache !== undefined,
        }
      )
      stageDependencyTelemetry(
        context,
        trace.details,
        trace.dependencyEvaluations,
        trace.dependencyExposures,
        this.exposureCache,
        this.dependencyTelemetrySidecar
      )
      details = trace.details
    } else {
      const metadata = createEvaluationMetadata(
        timeStampNow(),
        configuration.precomputed!.response.data.attributes.observeFullEvaluationData
      )
      const result = evaluatePrecomputedConfiguration(
        configuration,
        type,
        flagKey,
        defaultValue,
        context,
        this.experimentationOptOutMode,
        logger
      )
      details = { ...result, flagMetadata: { ...result.flagMetadata, ...metadata } }
    }
    if (this.exposureCache) {
      prepareExposure(
        context,
        { flagKey, variant: details.variant, flagMetadata: details.flagMetadata ?? {} },
        this.exposureCache
      )
    }
    return details
  }
}

function snapshotConfiguration(configuration: FlagsConfiguration): FlagsConfiguration {
  try {
    const rules = configuration.rules
    if (rules?.response.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration') {
      // Reuse the wire codec for validation and ownership. Ignore context-bound precomputed entries.
      const snapshot = configurationFromString(configurationToString({ rules }))
      if (snapshot.rules) return snapshot
    } else if (rules === undefined) {
      const snapshot = configurationFromString(configurationToString({ precomputed: configuration.precomputed }))
      if (snapshot.precomputed) return snapshot
    }
  } catch {
    // Caller-controlled configuration and accessor errors must not leak into diagnostics.
  }
  throw new TypeError('DatadogCoreProvider requires a valid rules-based or precomputed configuration')
}

function configurationGeneration(configuration: FlagsConfiguration): string {
  if (configuration.rules) {
    const createdAt = configuration.rules.response.createdAt
    return `rules:${createdAt?.seconds}:${createdAt?.nanos}`
  }
  return `precomputed:${configuration.precomputed!.response.data.attributes.createdAt}`
}
