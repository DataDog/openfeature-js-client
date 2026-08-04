import type { AssignmentCache, FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import { evaluate, type FlagsConfigurationError, getFlagsConfigurationError } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  FlagValueType,
  Hook,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { InvalidContextError, ParseError, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import {
  type FlaggingTrackingInitConfiguration,
  validateAndBuildFlaggingTrackingConfiguration,
} from '../domain/configuration'
import { DatadogCoreProvider } from './core-provider'
import { toProviderErrorEvent } from './error-event'
import { createProviderTracking } from './tracking'

export interface DatadogOfflineProviderOptions {
  /**
   * Optional browser telemetry transport and tracking settings. Offline evaluation never fetches
   * configuration. Tracking is disabled when this property is omitted; when supplied, integrations
   * use the same defaults as DatadogProvider and can be disabled individually.
   */
  tracking?: FlaggingTrackingInitConfiguration
}

export class DatadogOfflineProvider extends DatadogCoreProvider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-offline',
  }
  hooks?: Hook[]

  private flagsConfiguration: FlagsConfiguration | undefined
  private context: EvaluationContext | undefined
  private readonly exposureCache?: AssignmentCache

  constructor(options: DatadogOfflineProviderOptions = {}) {
    super()
    const trackingConfiguration = options.tracking
      ? validateAndBuildFlaggingTrackingConfiguration(options.tracking)
      : undefined
    const tracking = createProviderTracking({
      options: options.tracking ?? {},
      configuration: trackingConfiguration,
      enabledByDefault: options.tracking !== undefined,
      getTrackingContext: (context) => context,
      serializeExposureCacheLifecycle: true,
    })
    this.hooks = tracking.hooks
    this.exposureCache = tracking.exposureCache
  }

  getConfiguration(): FlagsConfiguration | undefined {
    return this.flagsConfiguration
  }

  setConfiguration(configuration: FlagsConfiguration): void {
    const hadEvaluatableConfiguration = this.canEvaluateCurrentContext()
    this.flagsConfiguration = configuration
    try {
      void Promise.resolve(this.exposureCache?.clear()).catch(() => {
        // Telemetry cache failures must not prevent configuration updates.
      })
    } catch {
      // Telemetry cache failures must not prevent configuration updates.
    }

    if (this.context === undefined) return

    const error = toOpenFeatureError(getFlagsConfigurationError(configuration, this.context))
    if (error) {
      this.events.emit(ProviderEvents.Error, toProviderErrorEvent(error))
      return
    }

    if (!hadEvaluatableConfiguration) {
      this.events.emit(ProviderEvents.Ready)
    }
    this.events.emit(ProviderEvents.ConfigurationChanged)
  }

  initialize(context: EvaluationContext = {}): Promise<void> {
    this.context = context

    let cacheInitialization: Promise<void>
    try {
      cacheInitialization = Promise.resolve(this.exposureCache?.init())
    } catch {
      // Telemetry cache failures must not prevent offline evaluation.
      cacheInitialization = Promise.resolve()
    }

    return cacheInitialization
      .catch(() => {})
      .then(() => {
        const error = toOpenFeatureError(getFlagsConfigurationError(this.flagsConfiguration, context))
        if (error) {
          return Promise.reject(error)
        }
      })
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    this.context = newContext
    const error = toOpenFeatureError(getFlagsConfigurationError(this.flagsConfiguration, this.context))
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
    return evaluate(this.flagsConfiguration, type, flagKey, defaultValue, context, logger)
  }

  private canEvaluateCurrentContext(): boolean {
    return this.context !== undefined && !getFlagsConfigurationError(this.flagsConfiguration, this.context)
  }
}

function toOpenFeatureError(error: FlagsConfigurationError | undefined): Error | undefined {
  if (!error) return undefined
  if (error.errorCode === 'PARSE_ERROR') return new ParseError(error.errorMessage)
  if (error.errorCode === 'INVALID_CONTEXT') return new InvalidContextError(error.errorMessage)
  return new ProviderNotReadyError(error.errorMessage)
}
