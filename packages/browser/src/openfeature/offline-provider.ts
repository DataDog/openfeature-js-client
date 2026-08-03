import type { FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import { configMatchesContext, evaluate } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  FlagValueType,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { InvalidContextError, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import { DatadogCoreProvider } from './core-provider'

export interface DatadogOfflineProviderOptions {
  configuration: FlagsConfiguration
}

export class DatadogOfflineProvider extends DatadogCoreProvider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-offline',
  }

  private flagsConfiguration: FlagsConfiguration
  private context: EvaluationContext = {}

  constructor(options: DatadogOfflineProviderOptions) {
    super()
    this.flagsConfiguration = options.configuration
  }

  getConfiguration(): FlagsConfiguration {
    return this.flagsConfiguration
  }

  setConfiguration(configuration: FlagsConfiguration): void {
    const hadEvaluatableConfiguration = this.canEvaluateCurrentContext()
    this.flagsConfiguration = configuration

    const error = getConfigurationError(configuration, this.context)
    if (error) {
      this.events.emit(ProviderEvents.Error, { error })
      return
    }

    if (!hadEvaluatableConfiguration) {
      this.events.emit(ProviderEvents.Ready)
    }
    this.events.emit(ProviderEvents.ConfigurationChanged)
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    this.context = context
    const error = getConfigurationError(this.flagsConfiguration, this.context)
    if (error) {
      throw error
    }
  }

  onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): void {
    this.context = newContext
    const error = getConfigurationError(this.flagsConfiguration, this.context)
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
    return !getConfigurationError(this.flagsConfiguration, this.context)
  }
}

function hasEvaluatableConfiguration(configuration: FlagsConfiguration): boolean {
  return !!(configuration.precomputed || configuration.rules)
}

function getConfigurationError(configuration: FlagsConfiguration, context: EvaluationContext): Error | undefined {
  if (!hasEvaluatableConfiguration(configuration)) {
    return new ProviderNotReadyError('No flags configuration has been set')
  }

  if (!configuration.rules && configuration.precomputed && !configMatchesContext(configuration, context)) {
    return new InvalidContextError('Precomputed flags configuration does not match the current context')
  }

  return undefined
}
