import type { FlagsConfiguration, FlagTypeToValue } from '@datadog/flagging-core'
import {
  configMatchesContext,
  evaluate,
  type FlagsConfigurationError,
  getFlagsConfigurationError,
  getMD5Hash,
} from '@datadog/flagging-core'
import { configurationToString } from '@datadog/flagging-core/rules-based'
import type {
  EvaluationContext,
  FlagValueType,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { InvalidContextError, ParseError, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import { withCoreConfigurationId } from './core-provider-metadata'
import { toProviderErrorEvent } from './error-event'
import { DatadogProviderBase } from './provider-base'

export class DatadogCoreProvider extends DatadogProviderBase {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-core',
  }

  private flagsConfiguration: FlagsConfiguration | undefined
  private flagsConfigurationId: string | undefined
  private fallbackConfigurationSequence = 0
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
    this.flagsConfigurationId = this.computeConfigurationId(configuration)

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

    const error = toOpenFeatureError(getFlagsConfigurationError(this.flagsConfiguration, context))
    return error ? Promise.reject(error) : Promise.resolve()
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
    const details = evaluate(this.flagsConfiguration, type, flagKey, defaultValue, context, logger)
    return withCoreConfigurationId(details, this.getExposureConfigurationId(flagKey, details, context))
  }

  private getExposureConfigurationId(
    flagKey: string,
    details: ResolutionDetails<FlagTypeToValue<FlagValueType>>,
    context: EvaluationContext
  ): string | undefined {
    const precomputed = this.flagsConfiguration?.precomputed
    if (
      !precomputed ||
      !configMatchesContext(this.flagsConfiguration, context) ||
      details.flagMetadata?.doLog !== true
    ) {
      return this.flagsConfigurationId
    }

    try {
      // A new salt changes the wire keys, not the assignment. Use the original
      // key and resolved assignment to keep exposure deduplication unchanged.
      const {
        flags: _flags,
        obfuscated: _obfuscated,
        obfuscation: _obfuscation,
        ...attributes
      } = precomputed.response.data.attributes
      return getMD5Hash(JSON.stringify({ attributes, context: precomputed.context, flagKey, details }))
    } catch {
      return this.flagsConfigurationId
    }
  }

  private canEvaluateCurrentContext(): boolean {
    return this.context !== undefined && !getFlagsConfigurationError(this.flagsConfiguration, this.context)
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
