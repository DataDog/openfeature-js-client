import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  createExposureEvent,
  type ExposureEvent,
  LRUInMemoryAssignmentCache,
} from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/core'
import type {
  EvaluationDetails,
  FlagValue,
  Hook,
  JsonValue,
  Logger,
  Paradigm,
  Provider,
  ProviderEventEmitter,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/server-sdk'
import { OpenFeatureEventEmitter, ProviderEvents } from '@openfeature/server-sdk'
import { evaluate } from './configuration/evaluation'
import type { UniversalFlagConfigurationV1 } from './configuration/ufc-v1'

/**
 * Default timeout in milliseconds for provider initialization.
 */
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30000

export interface DatadogNodeServerProviderOptions {
  /**
   * Log experiment exposures
   */
  exposureChannel: Channel<ExposureEvent>
  /**
   * Timeout in milliseconds for provider initialization.
   * If the configuration is not set within this time, initialization will fail.
   * @default DEFAULT_INITIALIZATION_TIMEOUT_MS (30000ms / 30 seconds)
   */
  initializationTimeoutMs?: number
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
  private readonly exposureCache: AssignmentCache | undefined

  private configuration?: UniversalFlagConfigurationV1 | undefined

  constructor(private readonly options: DatadogNodeServerProviderOptions) {
    this.hooks = []
    this.events = new OpenFeatureEventEmitter()
    this.exposureCache = new LRUInMemoryAssignmentCache(50_000)
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
    const prevCreatedAt = this.configuration?.createdAt
    if (this.configuration && this.configuration !== configuration) {
      this.events.emit(ProviderEvents.ConfigurationChanged)
      const newCreatedAt = configuration?.createdAt
      if (prevCreatedAt !== newCreatedAt) {
        this.exposureCache?.clear()
      }
      this.configuration = configuration
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
  async initialize(): Promise<void> {
    if (this.configuration) {
      return
    }
    const timeoutMs = this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        this.resolveInitialization = resolve
        this.rejectInitialization = reject
      }),
      new Promise<void>(() => {
        setTimeout(() => {
          this.setError(new Error(`Initialization timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    await this.exposureCache?.init()
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
    const timestamp = Date.now()
    const evalutationDetails: EvaluationDetails<T> = {
      ...resolutionDetails,
      flagKey: flagKey,
      flagMetadata: resolutionDetails.flagMetadata ?? {},
    }
    const exposureEvent = createExposureEvent(context, evalutationDetails)
    if (!exposureEvent) {
      return
    }
    const hasLoggedAssignment = this.exposureCache?.has(exposureEvent)
    if (hasLoggedAssignment) {
      return
    }
    if (this.options.exposureChannel.hasSubscribers) {
      this.options.exposureChannel.publish({ ...exposureEvent, timestamp })
      this.exposureCache?.set(exposureEvent)
    }
  }
}
