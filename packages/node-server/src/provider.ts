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
} from '@openfeature/server-sdk'

import { EvaluationContext } from '@openfeature/core'
import { ProviderStatus } from '@openfeature/server-sdk'
import { evaluate } from './configuration/evaluation'
import { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'
import { ExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent.types'
import { createExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent'
import type { Channel } from 'node:diagnostics_channel';

export interface DatadogNodeServerProviderOptions {
  /**
   * Remote config agent
   */
  configuration?: UniversalFlagConfigurationV1;
  
  /**
   * Log experiment exposures
   */
  exposureChannel: Channel<ExposureEvent>;
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  readonlyhooks?: Hook[]

  status: ProviderStatus = ProviderStatus.NOT_READY
  private configuration?: UniversalFlagConfigurationV1

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.configuration = options.configuration
    if (this.configuration) {
      this.status = ProviderStatus.READY
    }
  }

  getConfiguration() {
    return this.configuration
  }

  setConfiguration(configuration: UniversalFlagConfigurationV1) {
    this.configuration = configuration
    if (this.configuration) {
      this.status = ProviderStatus.READY
    } else {
      this.status = ProviderStatus.NOT_READY
    }
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
    const resolutionDetails = evaluate(this.configuration, 'object', flagKey, defaultValue, context, _logger) as ResolutionDetails<T>
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  private handleExposure<T extends FlagValue>(flagKey: string, context: EvaluationContext, resolutionDetails: ResolutionDetails<T>): void {
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
