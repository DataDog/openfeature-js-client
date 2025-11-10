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
import { InitializationController } from './initialization-controller'

/**
 * Default timeout in milliseconds for provider initialization.
 */
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000

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
  /**
   * Optional logger for provider diagnostics.
   * If not provided, will fall back to console for error logging.
   */
  logger?: Logger
}

export class DatadogNodeServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog-node-server',
  }
  readonly runsOn: Paradigm = 'server'
  readonly hooks?: Hook[]

  private initController?: InitializationController
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
    const hadConfiguration = !!this.configuration

    if (hadConfiguration && this.configuration !== configuration) {
      this.events.emit(ProviderEvents.ConfigurationChanged)
      const newCreatedAt = configuration?.createdAt
      if (prevCreatedAt !== newCreatedAt) {
        this.exposureCache?.clear()
      }
      this.configuration = configuration
      return
    }

    this.configuration = configuration

    if (this.initController?.isInitializing()) {
      // First configuration during initialization - resolve the initialization promise
      // This will cause OpenFeature SDK to emit PROVIDER_READY
      this.initController.complete()
    } else if (!hadConfiguration) {
      // Configuration is being set after initialization completed/failed (e.g., after timeout)
      // Emit PROVIDER_READY to signal recovery from error state
      this.events.emit(ProviderEvents.Ready)
    }
  }

  /**
   * Used by dd-source-js
   */
  setError(error: unknown) {
    if (this.initController?.isInitializing()) {
      this.initController.fail(error)
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
   * loading functionality via InitializationController.
   * See setConfiguration and setError for more details.
   */
  async initialize(): Promise<void> {
    if (this.configuration) {
      return
    }

    const timeoutMs = this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
    this.initController = new InitializationController(timeoutMs, () => {
      const error = new Error(`Initialization timeout after ${timeoutMs}ms`)
      const logger = this.options.logger ?? console
      logger.error('Provider initialization timeout after %dms', timeoutMs, error)
      this.setError(error)
    })

    await this.initController.wait()
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
