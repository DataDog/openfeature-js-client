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
import { OpenFeatureEventEmitter, type ProviderEventEmitter, type ProviderEvents } from '@openfeature/web-sdk'

import { createDebugLogger, type DebugConfiguration, type DebugLogger } from '../debug'

/** Shared OpenFeature evaluation surface for Datadog's browser providers. */
export abstract class DatadogProviderBase implements Provider {
  abstract readonly metadata: ProviderMetadata
  readonly runsOn: Paradigm = 'client'
  readonly events: ProviderEventEmitter<ProviderEvents>

  protected readonly debug: DebugLogger
  private evaluationSequence = 0

  protected constructor(options: DebugConfiguration = {}) {
    this.debug = createDebugLogger(options.debugMode)
    const events = new OpenFeatureEventEmitter()
    this.events = events
    if (this.debug.enabled) {
      // OpenFeature isolates sync/async handler failures and reports them through its logger.
      // Observe that boundary without changing handler registration, removal, or error isolation.
      events.setLogger({
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, ...args) => this.debug.event('provider.listener_failed', () => ({ message, args })),
      })
      const emit = this.events.emit.bind(this.events)
      this.events.emit = ((...args: Parameters<typeof emit>) => {
        this.debug.event('provider.event', () => ({ name: args[0], payload: args[1] }))
        return emit(...args)
      }) as typeof this.events.emit
    }
  }

  protected debugEvaluationFields(): Record<string, unknown> {
    return {}
  }

  private resolveWithDebug<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>> {
    if (!this.debug.enabled) return this.resolve(type, flagKey, defaultValue, context, logger)
    const evaluationId = ++this.evaluationSequence
    const started = performance.now()
    const debug = this.debug.child({ evaluationId, flagKey })
    try {
      const result = this.resolve(type, flagKey, defaultValue, context, debug.logger(logger))
      debug.event('evaluation.completed', () => ({
        ...this.debugEvaluationFields(),
        requestedType: type,
        defaultValue,
        requestedContext: context,
        result,
        valueOrigin: result.flagMetadata?.overridden
          ? 'local_override'
          : result.variant == null
            ? 'runtime_default'
            : 'assigned_variant',
        runtimeDefaultUsed: result.variant == null && !result.flagMetadata?.overridden,
        durationMs: performance.now() - started,
      }))
      return result
    } catch (error) {
      debug.event('evaluation.failed', () => ({ requestedType: type, defaultValue, requestedContext: context, error }))
      throw error
    }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<boolean> {
    return this.resolveWithDebug('boolean', flagKey, defaultValue, context, logger)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<string> {
    return this.resolveWithDebug('string', flagKey, defaultValue, context, logger)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<number> {
    return this.resolveWithDebug('number', flagKey, defaultValue, context, logger)
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<T> {
    // OpenFeature requires a specific subtype of JsonValue without providing runtime type information.
    // Callers are responsible for passing a default value with the expected object shape.
    return this.resolveWithDebug('object', flagKey, defaultValue, context, logger) as ResolutionDetails<T>
  }

  protected abstract resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    context: EvaluationContext,
    logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>>
}
