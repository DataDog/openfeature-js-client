import type { FlagTypeToValue } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  FlagValueType,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import { OpenFeatureEventEmitter, type ProviderEventEmitter, ProviderEvents } from '@openfeature/web-sdk'

/** Shared OpenFeature evaluation surface for Datadog's browser providers. */
export abstract class DatadogCoreProvider implements Provider {
  abstract readonly metadata: ProviderMetadata
  readonly runsOn: Paradigm = 'client'
  readonly events: ProviderEventEmitter<ProviderEvents>

  protected constructor() {
    this.events = new OpenFeatureEventEmitter()
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
    // OpenFeature requires a specific subtype of JsonValue without providing runtime type information.
    // Callers are responsible for passing a default value with the expected object shape.
    return this.resolve('object', flagKey, defaultValue, context, logger) as ResolutionDetails<T>
  }

  protected abstract resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>>
}
