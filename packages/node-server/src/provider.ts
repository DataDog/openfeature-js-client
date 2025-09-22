import type {
  JsonValue,
  Logger,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
  Paradigm,
  Hook,
} from '@openfeature/server-sdk'

import { EvaluationContext } from '@openfeature/core'
import { ProviderStatus } from '@openfeature/server-sdk'
import { evaluate } from './configuration/evaluation'
import { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'

export interface DatadogNodeServerProviderOptions {
  /**
   * Remote config agent
   */
  configuration: UniversalFlagConfigurationV1
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  hooks?: Hook[]

  status: ProviderStatus = ProviderStatus.NOT_READY
  private configuration: UniversalFlagConfigurationV1

  constructor(options: DatadogNodeServerProviderOptions) {
    this.configuration = options.configuration
    this.status = ProviderStatus.READY
  }

  getConfiguration() {
    return this.configuration
  }

  setConfiguration(configuration: UniversalFlagConfigurationV1) {
    this.configuration = configuration
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    return evaluate(this.configuration, 'boolean', flagKey, defaultValue, context, _logger)
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    return evaluate(this.configuration, 'string', flagKey, defaultValue, context, _logger)
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    return evaluate(this.configuration, 'number', flagKey, defaultValue, context, _logger)
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
    return evaluate(this.configuration, 'object', flagKey, defaultValue, context, _logger) as ResolutionDetails<T>
  }
}
