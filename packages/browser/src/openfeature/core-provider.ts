import type { FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import { configMatchesContext } from '@datadog/flagging-core'
import type {
  ErrorCode,
  EvaluationContext,
  FlagValueType,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import {
  OpenFeatureEventEmitter,
  type ProviderEventEmitter,
  ProviderEvents,
} from '@openfeature/web-sdk'
import { evaluate } from '../evaluation'

export interface CoreProviderOptions {
  configuration: FlagsConfiguration
}

export class CoreProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-core',
  }
  readonly runsOn: Paradigm = 'client'
  readonly events: ProviderEventEmitter<ProviderEvents>

  private flagsConfiguration: FlagsConfiguration
  private context: EvaluationContext = {}

  constructor(options: CoreProviderOptions) {
    this.events = new OpenFeatureEventEmitter()
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

    this.events.emit(hadEvaluatableConfiguration ? ProviderEvents.ConfigurationChanged : ProviderEvents.Ready)
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    this.context = context
    const error = getConfigurationError(this.flagsConfiguration, this.context)
    if (error) {
      throw error
    }
  }

  async onContextChange(_oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    this.context = newContext
    const error = getConfigurationError(this.flagsConfiguration, this.context)
    if (error) {
      this.events.emit(ProviderEvents.Error, { error })
      throw error
    }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<boolean> {
    return this.resolve('boolean', flagKey, defaultValue, context, logger)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<string> {
    return this.resolve('string', flagKey, defaultValue, context, logger)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<number> {
    return this.resolve('number', flagKey, defaultValue, context, logger)
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<T> {
    return this.resolve('object', flagKey, defaultValue, context, logger) as ResolutionDetails<T>
  }

  private resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>> {
    if (!hasEvaluatableConfiguration(this.flagsConfiguration)) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY' as ErrorCode,
      }
    }

    return evaluate(this.flagsConfiguration, type, flagKey, defaultValue, this.getEvaluationContext(context), logger)
  }

  private getEvaluationContext(context: EvaluationContext): EvaluationContext {
    if (Object.keys(context).length > 0 || Object.keys(this.context).length === 0) {
      return context
    }
    return this.context
  }

  private canEvaluateCurrentContext(): boolean {
    return !getConfigurationError(this.flagsConfiguration, this.context)
  }
}

function hasEvaluatableConfiguration(configuration: FlagsConfiguration): boolean {
  return !!(configuration.precomputed || configuration.rulesBased)
}

function getConfigurationError(configuration: FlagsConfiguration, context: EvaluationContext): Error | undefined {
  if (!hasEvaluatableConfiguration(configuration)) {
    return new Error('No flags configuration has been set')
  }

  if (!configuration.rulesBased && configuration.precomputed && !configMatchesContext(configuration, context)) {
    return new Error('Precomputed flags configuration does not match the current context')
  }

  return undefined
}
