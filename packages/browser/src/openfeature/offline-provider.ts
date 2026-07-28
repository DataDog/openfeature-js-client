import type { FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import { evaluate, type FlagsConfigurationError, getFlagsConfigurationError } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  FlagValueType,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { InvalidContextError, ParseError, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import { DatadogCoreProvider } from './core-provider'
import { toProviderErrorEvent } from './error-event'

export class DatadogOfflineProvider extends DatadogCoreProvider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-offline',
  }

  private flagsConfiguration: FlagsConfiguration | undefined
  private context: EvaluationContext = {}

  constructor() {
    super()
  }

  getConfiguration(): FlagsConfiguration | undefined {
    return this.flagsConfiguration
  }

  setConfiguration(configuration: FlagsConfiguration): void {
    const hadEvaluatableConfiguration = this.canEvaluateCurrentContext()
    this.flagsConfiguration = configuration

    const error = toOpenFeatureError(
      getFlagsConfigurationError(configuration, getEffectiveContext(configuration, this.context))
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
    this.context = context
    const error = toOpenFeatureError(
      getFlagsConfigurationError(
        this.flagsConfiguration,
        getEffectiveContext(this.flagsConfiguration, this.context)
      )
    )
    if (error) {
      throw error
    }
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    this.context = newContext
    const error = toOpenFeatureError(
      getFlagsConfigurationError(
        this.flagsConfiguration,
        getEffectiveContext(this.flagsConfiguration, this.context)
      )
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
    return evaluate(
      this.flagsConfiguration,
      type,
      flagKey,
      defaultValue,
      getEffectiveContext(this.flagsConfiguration, context),
      logger
    )
  }

  private canEvaluateCurrentContext(): boolean {
    return !getFlagsConfigurationError(
      this.flagsConfiguration,
      getEffectiveContext(this.flagsConfiguration, this.context)
    )
  }
}

function toOpenFeatureError(error: FlagsConfigurationError | undefined): Error | undefined {
  if (!error) return undefined
  if (error.errorCode === 'PARSE_ERROR') return new ParseError(error.errorMessage)
  if (error.errorCode === 'INVALID_CONTEXT') return new InvalidContextError(error.errorMessage)
  return new ProviderNotReadyError(error.errorMessage)
}

function getEffectiveContext(
  configuration: FlagsConfiguration | undefined,
  context: EvaluationContext
): EvaluationContext {
  // An empty OpenFeature context means there is no external override for an offline precomputed configuration.
  if (isEmptyContext(context) && configuration.precomputed?.context) {
    return configuration.precomputed.context
  }

  return context
}

function isEmptyContext(context: EvaluationContext): boolean {
  return Object.values(context).every((value) => value === undefined)
}
