import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  type ExposureEvent,
  type FlagsConfiguration,
  type FlagTypeToValue,
  LRUInMemoryAssignmentCache,
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
  /** Optional exposure sink owned by the tracer integration. Does not initialize an uploader. @internal */
  exposureChannel?: Channel<ExposureEvent>
  /** Consumed by the integration's root evaluation hook. @internal */
  dependencyTelemetrySidecar?: DependencyTelemetrySidecarApi
}

/** Locally initialized, rules-only provider. Fetching and event delivery are caller-owned. */
export class DatadogCoreProvider implements Provider {
  readonly metadata = { name: 'datadog-core' }
  readonly runsOn = 'server' as const
  readonly hooks: Hook[] = []
  readonly events: ProviderEventEmitter<ServerProviderEvents> = new NodeProviderEventEmitter()
  private configuration: FlagsConfiguration
  private readonly experimentationOptOutMode: ExperimentationOptOutMode
  private readonly exposureCache: AssignmentCache | undefined
  private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecarApi

  // No initialize(): valid rules are required before OpenFeature registration.
  constructor(configuration: FlagsConfiguration, options: DatadogCoreProviderOptions = {}) {
    this.experimentationOptOutMode = resolveExperimentationOptOutMode(options.experimentationOptOutMode)
    this.configuration = snapshotRules(configuration)
    this.dependencyTelemetrySidecar = options.dependencyTelemetrySidecar ?? new DependencyTelemetrySidecar(false)
    if (options.exposureChannel) {
      this.exposureCache = new LRUInMemoryAssignmentCache(50_000)
      this.hooks.push(
        new ExposureLoggingHook(this.exposureCache, options.exposureChannel, this.dependencyTelemetrySidecar)
      )
    }
  }

  /** Return a detached copy; apply replacements with setConfiguration(). */
  getConfiguration(): FlagsConfiguration {
    return snapshotRules(this.configuration)
  }

  /** Validate before replacing the active snapshot. Failure leaves it unchanged. */
  setConfiguration(configuration: FlagsConfiguration): void {
    const next = snapshotRules(configuration)
    const previousCreatedAt = this.configuration.rules!.response.createdAt
    const nextCreatedAt = next.rules!.response.createdAt
    this.configuration = next
    if (previousCreatedAt?.seconds !== nextCreatedAt?.seconds || previousCreatedAt?.nanos !== nextCreatedAt?.nanos) {
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
    // The evaluator caches decoded JSON values. Do not share them between requests.
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
    const trace = evaluateWithTrace(
      this.configuration.rules!.response,
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
    if (this.exposureCache) {
      prepareExposure(
        context,
        { flagKey, variant: trace.details.variant, flagMetadata: trace.details.flagMetadata ?? {} },
        this.exposureCache
      )
    }
    return trace.details
  }
}

function snapshotRules(configuration: FlagsConfiguration): FlagsConfiguration {
  try {
    const rules = configuration.rules
    if (rules?.response.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration') {
      // Reuse the wire codec for validation and ownership. Ignore context-bound precomputed entries.
      const snapshot = configurationFromString(configurationToString({ rules }))
      if (snapshot.rules) return snapshot
    }
  } catch {
    // Caller-controlled configuration and accessor errors must not leak into diagnostics.
  }
  throw new TypeError('DatadogCoreProvider requires a valid rules-based configuration')
}
