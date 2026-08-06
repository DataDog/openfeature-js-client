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
  private context: EvaluationContext | undefined

  constructor() {
    super()
  }

  getConfiguration(): FlagsConfiguration | undefined {
    return this.flagsConfiguration
  }

  setConfiguration(configuration: FlagsConfiguration): void {
    const hadEvaluatableConfiguration = this.canEvaluateCurrentContext()
    this.flagsConfiguration = configuration

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
    const error = toOpenFeatureError(getFlagsConfigurationError(this.flagsConfiguration, this.context))
    if (error) {
      return Promise.reject(error)
    }

    return Promise.resolve()
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
