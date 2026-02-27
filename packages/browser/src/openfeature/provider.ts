import type { AssignmentCache, FlagsConfiguration } from '@datadog/flagging-core'
import type {
  EvaluationContext,
  Hook,
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
  ProviderStatus,
} from '@openfeature/web-sdk'
import { assignmentCacheFactory } from '../cache/assignment-cache-factory'
import { chromeStorageIfAvailable, hasIndexedDB } from '../cache/helpers'
import { IndexedDBFlagsCache } from '../cache/indexeddb-flags-cache'
import {
  type FlaggingConfiguration,
  type FlaggingInitConfiguration,
  validateAndBuildFlaggingConfiguration,
} from '../domain/configuration'
import { evaluate } from '../evaluation'
import { createExposureLoggingHook } from './exposures'
import { createFlagEvaluationTrackingHook } from './flagEvaluations'
import { createRumTrackingHook } from './rumIntegration'

/**
 * @deprecated Use FlaggingInitConfiguration instead
 */
export type DatadogProviderOptions = FlaggingInitConfiguration

// We need to use a class here to properly implement the OpenFeature Provider interface
// which requires class methods and properties. This is a valid exception to the no-classes rule.
/* eslint-disable-next-line no-restricted-syntax */
export class DatadogProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'datadog',
  }
  readonly runsOn: Paradigm = 'client'
  hooks?: Hook[]
  readonly events: ProviderEventEmitter<ProviderEvents>

  status: ProviderStatus
  private flagsConfiguration: FlagsConfiguration = {}
  private configuration?: FlaggingConfiguration
  private exposureCache: AssignmentCache | undefined
  private flagsCache: IndexedDBFlagsCache | undefined
  private readonly hasInitialFlagsConfiguration: boolean

  constructor(options: FlaggingInitConfiguration) {
    this.configuration = validateAndBuildFlaggingConfiguration(options)

    // Set up provider-managed hooks and events
    this.hooks = []
    this.events = new OpenFeatureEventEmitter()

    const isRumFeatureFlagTrackingEnabled = options.enableRumFeatureFlagTracking ?? true
    if (isRumFeatureFlagTrackingEnabled) {
      this.hooks.push(createRumTrackingHook())
    }

    // Add flag evaluation tracking hook
    const isEvaluationTrackingEnabled = options.enableFlagEvaluationTracking ?? true
    if (isEvaluationTrackingEnabled && this.configuration) {
      this.hooks.push(createFlagEvaluationTrackingHook(this.configuration))
    }

    // Add proper exposure logging hook (creates batch internally)
    const isExposureLoggingEnabled = options.enableExposureLogging ?? true
    if (isExposureLoggingEnabled && this.configuration) {
      this.exposureCache = assignmentCacheFactory({
        chromeStorage: chromeStorageIfAvailable(),
        storageKeySuffix: 'dd-of-browser',
      })
      this.hooks.push(createExposureLoggingHook(this.configuration, this.exposureCache))
    }

    if (hasIndexedDB()) {
      this.flagsCache = new IndexedDBFlagsCache(options.clientToken)
    }

    this.hasInitialFlagsConfiguration = !!options.initialFlagsConfiguration

    if (options.initialFlagsConfiguration) {
      this.flagsConfiguration = options.initialFlagsConfiguration
      this.status = ProviderStatus.READY
    } else {
      this.flagsConfiguration = {}
      this.status = ProviderStatus.NOT_READY
    }
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }

    // Start all async work concurrently — cache read should not delay the fetch.
    const cachedConfigPromise = !this.hasInitialFlagsConfiguration ? this.flagsCache?.get(context) : undefined
    const exposureCacheReady = this.exposureCache?.init()

    try {
      this.flagsConfiguration = await this.fetchFlagsAndMaybeClearExposureCache(context)
      // Fire-and-forget: cache write should not block readiness
      this.flagsCache?.set(this.flagsConfiguration, context)
    } catch (error) {
      // Network failed — try to serve from cache or initialFlagsConfiguration
      const cachedConfig = await cachedConfigPromise
      if (cachedConfig?.precomputed) {
        this.flagsConfiguration = cachedConfig
      }
      if (this.flagsConfiguration?.precomputed) {
        this.status = ProviderStatus.STALE
        this.events.emit(ProviderEvents.Stale)
        await exposureCacheReady
        return
      }
      throw error
    }
    this.status = ProviderStatus.READY
    await exposureCacheReady
  }

  async onContextChange(_oldContext: EvaluationContext, context: EvaluationContext): Promise<void> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    this.status = ProviderStatus.RECONCILING
    try {
      this.flagsConfiguration = await this.fetchFlagsAndMaybeClearExposureCache(context)
      // Fire-and-forget: cache write should not block readiness
      this.flagsCache?.set(this.flagsConfiguration, context)
      this.status = ProviderStatus.READY
    } catch (error) {
      this.events.emit(ProviderEvents.Error, { error })
      this.status = ProviderStatus.ERROR
    }
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<boolean> {
    return evaluate(this.flagsConfiguration, 'boolean', flagKey, defaultValue, context)
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<string> {
    return evaluate(this.flagsConfiguration, 'string', flagKey, defaultValue, context)
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<number> {
    return evaluate(this.flagsConfiguration, 'number', flagKey, defaultValue, context)
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<T> {
    // type safety: OpenFeature interface requires us to return a
    // specific T for *any* value of T (which could be any subtype of
    // JsonValue). We can't even theoretically implement it in a
    // type-sound way because there's no runtime information passed to
    // learn what type the user expects. So it's up to the user to
    // make sure they pass the appropriate type.
    return evaluate(this.flagsConfiguration, 'object', flagKey, defaultValue, context) as ResolutionDetails<T>
  }

  private async fetchFlagsAndMaybeClearExposureCache(context: EvaluationContext): Promise<FlagsConfiguration> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    const prevCreatedAt = this.flagsConfiguration?.precomputed?.response.data.attributes.createdAt
    const flagsConfiguration = await this.configuration.fetchFlagsConfiguration(context)
    const newCreatedAt = flagsConfiguration.precomputed?.response.data.attributes.createdAt
    if (prevCreatedAt !== undefined && prevCreatedAt !== newCreatedAt) {
      await this.exposureCache?.clear()
    }
    return flagsConfiguration
  }
}
