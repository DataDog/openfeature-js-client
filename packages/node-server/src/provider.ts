import type {
  EvaluationDetails,
  JsonValue,
  Logger,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
  Paradigm,
  Hook,
  FlagValue,
  ProviderEventEmitter,
} from '@openfeature/server-sdk'

import { OpenFeatureEventEmitter, ProviderEvents } from '@openfeature/server-sdk'

import { EvaluationContext } from '@openfeature/core'
import { evaluate } from './configuration/evaluation'
import { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'
import { ExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent.types'
import { createExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent'
import type { Channel } from 'node:diagnostics_channel'

export interface DatadogNodeServerProviderOptions {
  /**
   * Log experiment exposures
   */
  exposureChannel: Channel<ExposureEvent>
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  readonly hooks?: Hook[]

  private resolveInitialization?: (value?: void | PromiseLike<void>) => void
  private rejectInitialization?: (reason?: unknown) => void
  readonly events: ProviderEventEmitter<ProviderEvents>

  private configuration?: UniversalFlagConfigurationV1 | undefined

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.hooks = []
    this.events = new OpenFeatureEventEmitter()
  }

  /**
   * Used by dd-source-js
   */
  getConfiguration() {
    return this.configuration
  }

  /**
   * Used by dd-source-js
   */
  setConfiguration(configuration: UniversalFlagConfigurationV1) {
    if (this.configuration && this.configuration !== configuration) {
      this.events.emit(ProviderEvents.ConfigurationChanged)
      return
    }
    this.configuration = configuration
    if (this.resolveInitialization) {
      this.resolveInitialization()
      this.resolveInitialization = undefined
      this.rejectInitialization = undefined
    }
  }

  /**
   * Used by dd-source-js
   */
  setError(error: unknown) {
    if (this.rejectInitialization) {
      this.rejectInitialization(error)
      this.resolveInitialization = undefined
      this.rejectInitialization = undefined
    } else {
      this.events.emit(ProviderEvents.Error, { error })
    }
  }

  /**
   * Used by the OpenFeature SDK to set the status based on initialization.
   * Status of 'PROVIDER_READY' is emitted with a resolved promise.
   * Status of 'PROVIDER_ERROR' is emitted with a rejected promise.
   *
   * Since we aren't loading the configuration in this Provider, we will simulate
   * loading functionality via resolveInitialization and rejectInitialization.
   * See setConfiguration and setError for more details.
   */
  initialize(): Promise<void> {
    if (this.configuration) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.resolveInitialization = resolve
      this.rejectInitialization = reject
    })
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    const resolutionDetails = evaluate(this.configuration, 'boolean', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    const resolutionDetails = evaluate(this.configuration, 'string', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    const resolutionDetails = evaluate(this.configuration, 'number', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
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
    const resolutionDetails = evaluate(
      this.configuration,
      'object',
      flagKey,
      defaultValue,
      context,
      _logger
    ) as ResolutionDetails<T>
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  private handleExposure<T extends FlagValue>(
    flagKey: string,
    context: EvaluationContext,
    resolutionDetails: ResolutionDetails<T>
  ): void {
    const evalutationDetails: EvaluationDetails<T> = {
      ...resolutionDetails,
      flagKey: flagKey,
      flagMetadata: resolutionDetails.flagMetadata ?? {},
    }
    const exposureEvent = createExposureEvent(context, evalutationDetails)
    if (exposureEvent && this.options.exposureChannel.hasSubscribers) {
      this.options.exposureChannel.publish(exposureEvent)
    }
  }
}
