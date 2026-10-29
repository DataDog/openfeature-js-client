import type { AssignmentCache, FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import {
  completeExposureDecision,
  evaluate,
  type FlagsConfigurationError,
  getFlagsConfigurationError,
  getMD5Hash,
} from '@datadog/flagging-core'
import { configurationToString } from '@datadog/flagging-core/rules-based'
import type {
  EvaluationContext,
  FlagValueType,
  Hook,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { InvalidContextError, ParseError, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import type { EvaluationTelemetryOptOutConfiguration } from '../domain/configuration'
import { withCoreConfigurationId } from './core-provider-metadata'
import { toProviderErrorEvent } from './error-event'
import {
  bindEvaluationTelemetryResult,
  createEvaluationTelemetryPolicy,
  type EvaluationTelemetryPolicy,
} from './evaluation-telemetry-policy'
import {
  type ExperimentationOptOutConfiguration,
  type ExperimentationOptOutMode,
  getExperimentationOptOutMode,
} from './experimentation-opt-out'
import { registerDatadogProvider, supportsExposureAdmission } from './exposure-scope'
import { stampExposureCacheVerdict } from './exposures'
import { DatadogProviderBase } from './provider-base'

export interface DatadogCoreProviderConfiguration
  extends EvaluationTelemetryOptOutConfiguration, ExperimentationOptOutConfiguration {
  /**
   * Exposure cache shared with a tracking controller
   * (`createDatadogExposureLoggingHook().exposureCache`). Enables the exposure
   * deduplication verdict in flag metadata, used by the public `ExposureHook`.
   * Without it, evaluations carry no exposure verdict.
   */
  exposureCache?: AssignmentCache
}

export class DatadogCoreProvider extends DatadogProviderBase {
  // Finalizes the shared exposure decision at provider level, so it is complete
  // before application after hooks (which may evaluate the same flag again)
  // and before the tracking and customer hooks read the verdict.
  readonly hooks: Hook[] = [
    {
      finally: (context, details) => {
        if (supportsExposureAdmission(context)) completeExposureDecision(details)
      },
    },
  ]

  readonly metadata: ProviderMetadata = {
    name: 'datadog-core',
  }

  private flagsConfiguration: FlagsConfiguration | undefined
  private flagsConfigurationId: string | undefined
  private fallbackConfigurationSequence = 0
  private context: EvaluationContext | undefined
  private readonly telemetryPolicy: EvaluationTelemetryPolicy
  private readonly experimentationOptOutMode: ExperimentationOptOutMode
  private readonly exposureCache: AssignmentCache | undefined

  constructor(options: DatadogCoreProviderConfiguration = {}) {
    super()
    this.experimentationOptOutMode = getExperimentationOptOutMode(options)
    this.exposureCache = options.exposureCache
    this.telemetryPolicy = createEvaluationTelemetryPolicy(this.metadata, options)
    registerDatadogProvider(this.metadata)
  }

  getConfiguration(): FlagsConfiguration | undefined {
    return this.flagsConfiguration
  }

  setConfiguration(configuration: FlagsConfiguration): void {
    const hadEvaluatableConfiguration = this.canEvaluateCurrentContext()
    this.flagsConfiguration = configuration
    this.flagsConfigurationId = this.computeConfigurationId(configuration)

    if (this.context === undefined) return

    const error = toOpenFeatureError(
      getFlagsConfigurationError(configuration, this.context, this.experimentationOptOutMode)
    )
    if (error) {
      this.events.emit(ProviderEvents.Error, toProviderErrorEvent(error))
      return
    }

    if (!hadEvaluatableConfiguration) {
      this.events.emit(ProviderEvents.Ready)
    }
    this.events.emit(ProviderEvents.ConfigurationChanged)
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    this.telemetryPolicy.setContext(context)
    this.context = context

    const error = toOpenFeatureError(
      getFlagsConfigurationError(this.flagsConfiguration, this.context, this.experimentationOptOutMode)
    )
    if (error) throw error
    // The shared IndexedDB-backed cache loads asynchronously; cache.init() is
    // idempotent and returns the same promise the tracking controller awaits,
    // so evaluations cannot run before the persisted entries are loaded.
    await this.exposureCache?.init()
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    this.telemetryPolicy.setContext(newContext)
    this.context = newContext
    const error = toOpenFeatureError(
      getFlagsConfigurationError(this.flagsConfiguration, this.context, this.experimentationOptOutMode)
    )
    if (error) {
      throw error
    }
  }

  protected resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>> {
    const result = withCoreConfigurationId(
      evaluate(this.flagsConfiguration, type, flagKey, defaultValue, context, logger, this.experimentationOptOutMode),
      this.flagsConfigurationId
    )
    // Stamp after the configuration id so the cache entry includes it; before
    // the SDK freezes the metadata for hooks.
    if (this.exposureCache) {
      stampExposureCacheVerdict({ ...result, flagKey }, context, this.exposureCache)
    }
    return bindEvaluationTelemetryResult(result, this.telemetryPolicy)
  }

  private canEvaluateCurrentContext(): boolean {
    return (
      this.context !== undefined &&
      !getFlagsConfigurationError(this.flagsConfiguration, this.context, this.experimentationOptOutMode)
    )
  }

  private computeConfigurationId(configuration: FlagsConfiguration): string {
    try {
      // Retrieval metadata and the UFC build timestamp can change without changing rules.
      // The backend's semantic Fingerprint() also excludes the rules' CreatedAt.
      return getMD5Hash(
        configurationToString({
          ...configuration,
          precomputed: configuration.precomputed && {
            ...configuration.precomputed,
            fetchedAt: undefined,
            etag: undefined,
          },
          rules: configuration.rules && {
            ...configuration.rules,
            response: { ...configuration.rules.response, createdAt: undefined },
            fetchedAt: undefined,
            etag: undefined,
          },
        })
      )
    } catch {
      this.fallbackConfigurationSequence += 1
      return `core-configuration-${this.fallbackConfigurationSequence}`
    }
  }
}

function toOpenFeatureError(error: FlagsConfigurationError | undefined): Error | undefined {
  if (!error) return undefined
  if (error.errorCode === 'PARSE_ERROR') return new ParseError(error.errorMessage)
  if (error.errorCode === 'INVALID_CONTEXT') return new InvalidContextError(error.errorMessage)
  return new ProviderNotReadyError(error.errorMessage)
}
