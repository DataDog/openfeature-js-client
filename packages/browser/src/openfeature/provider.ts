import { type AssignmentCache, configMatchesContext, type FlagsConfiguration } from '@datadog/flagging-core'
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
import { createFlagEvalLoggingHook } from './flagEvaluations'
import { createRumTrackingHook } from './rumIntegration'

/**
 * @deprecated Use FlaggingInitConfiguration instead
 */
export type DatadogProviderOptions = FlaggingInitConfiguration

/**
 * Wait for `promise` to resolve but automatically cancel the promise
 * if `signal` aborts.
 *
 * Note: it does not abort the `promise` itself and it will continue
 * running in the "background." Prefer native signal-aware interfaces
 * when possible and use `waitWithAbort` as a hacky way to interrupt
 * otherwise non-interruptible promises.
 */
function waitWithAbort<T>(signal: AbortSignal, promise: PromiseLike<T> | T): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    Promise.resolve(promise).then(resolve, reject)
  })
}

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

  /** Provider-level configuration */
  private readonly configuration?: FlaggingConfiguration

  status: ProviderStatus

  private flagsConfiguration: FlagsConfiguration = {}
  private flagsCache: IndexedDBFlagsCache | undefined

  private exposureCache: AssignmentCache | undefined
  private exposureCacheReady: Promise<void> | undefined

  /**
   * Concurrency control for initialize/onContextChange:
   *
   * Per OpenFeature spec, the SDK determines provider status from the
   * last onContextChange to TERMINATE (resolve/reject), not the last
   * to be CALLED. This creates a race condition when multiple calls
   * overlap.
   *
   * Solution:
   * 1. `contextUpdateAbortController`: allows aborting previous operation.
   * 2. `latestContextUpdate`: the last-called context update
   *    operation. When context updates finish, they check if they
   *    were aborted (meaning there's a newer context update) and
   *    delegate to it. This makes sure that all concurrent context
   *    updates resolve to the same result.
   */
  private latestContextUpdate: Promise<void> = Promise.resolve()
  private contextUpdateAbortController: AbortController = new AbortController()

  constructor(options: FlaggingInitConfiguration) {
    this.configuration = validateAndBuildFlaggingConfiguration(options)

    // Set up provider-managed hooks and events
    this.hooks = []
    this.events = new OpenFeatureEventEmitter()

    const isRumFeatureFlagTrackingEnabled = options.enableRumFeatureFlagTracking ?? true
    if (isRumFeatureFlagTrackingEnabled) {
      this.hooks.push(createRumTrackingHook())
    }

    // Add flag evaluation logging hook.
    const isEvaluationTrackingEnabled = options.enableFlagEvaluationTracking ?? true
    if (isEvaluationTrackingEnabled && this.configuration) {
      this.hooks.push(createFlagEvalLoggingHook(this.configuration))
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

    this.flagsConfiguration = options.initialFlagsConfiguration || {}
    this.status = ProviderStatus.NOT_READY
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    this.exposureCacheReady = this.exposureCache?.init()
    return this.setContext(context)
  }

  public onContextChange(_oldContext: EvaluationContext, context: EvaluationContext): Promise<void> {
    return this.setContext(context)
  }

  private setContext(context: EvaluationContext): Promise<void> {
    if (this.status === ProviderStatus.NOT_READY) {
      // we're initializing, no status changes necessary
    } else {
      this.status = ProviderStatus.RECONCILING
      this.events.emit(ProviderEvents.Reconciling)
    }

    // abort any previous setContext operation
    this.contextUpdateAbortController.abort()
    this.contextUpdateAbortController = new AbortController()

    const signal = this.contextUpdateAbortController.signal

    // Important: OF SDK awaits for all onContextChange calls to exit
    // before marking the provider as ready. Make sure to respect
    // `signal`, so we don't block OF SDK unnecessarily.
    this.latestContextUpdate = this.retrieveFlagsConfiguration(context, { signal })
      .then((result) =>
        // New configuration might require clearing exposure
        // cache. One example of this is updating experiment
        // boundaries: if we previously emitted exposure events for an
        // experiment and the new configuration bumped experiment
        // start time, we need to emit at least one new event within
        // the new experiment timeframe. We do that by clearing our
        // exposure
        this.maybeClearExposureCache(result.config, { signal }).then(
          () => result,
          // Ignore exposure cache errors. They should not prevent us from using the latest configuration.
          () => result
        )
      )
      .then(
        ({ config, fromCache }) => {
          if (signal.aborted) {
            // If signal was aborted, another setContext call has updated
            // this.latestContextUpdate, so we delegate to it.
            return this.latestContextUpdate
          }

          // If we get to here, we're the latest context update
          // call. We should update our state atomically here in a
          // single microtask (i.e., without any await/promise
          // scheduling).

          this.flagsConfiguration = config
          this.status = fromCache ? ProviderStatus.STALE : ProviderStatus.READY
          this.events.emit(ProviderEvents.ConfigurationChanged)

          if (this.status === ProviderStatus.STALE) {
            // HACK: returning from onContextChange causes the OF SDK
            // to overwrite its knowledge of provider status to READY
            // (even if we emit Stale event or set our own status to
            // STALE). Schedule a macrotask to notify the OF SDK of
            // the stale status when it's ready.
            setTimeout(() => {
              if (this.status === ProviderStatus.STALE) {
                this.events.emit(ProviderEvents.Stale)
              }
            }, 0)
          }
        },
        (error) => {
          if (signal.aborted) {
            // If signal was aborted, another setContext call has updated
            // this.latestContextUpdate, so we delegate to it.
            return this.latestContextUpdate
          } else {
            // Otherwise, this is a legitimate error
            this.status = ProviderStatus.ERROR
            this.events.emit(ProviderEvents.Error, { error })
            throw error
          }
        }
      )

    return this.latestContextUpdate
  }

  /**
   * Tries to retrieve flags configuration for the given evaluation
   * context. Prefers network, falls back to current configuration
   * (if context matches), then to persistent cache if network request fails.
   */
  private async retrieveFlagsConfiguration(
    context: EvaluationContext,
    { signal }: { signal: AbortSignal }
  ): Promise<{ config: FlagsConfiguration; fromCache: boolean }> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }

    // Prefer current config over cache if it matches the requested context
    const cachedConfigPromise = configMatchesContext(this.flagsConfiguration, context)
      ? Promise.resolve(this.flagsConfiguration)
      : this.flagsCache?.get(context)

    try {
      const config = await this.configuration.fetchFlagsConfiguration(context, { signal })
      this.flagsCache?.set(config, context)
      return { config, fromCache: false }
    } catch (err) {
      // Try to recover with current/cached config
      try {
        const config = await waitWithAbort(signal, cachedConfigPromise)
        if (config) {
          return { config, fromCache: true }
        }
      } catch (err) {}

      throw err
    }
  }

  private async maybeClearExposureCache(
    newFlagsConfiguration: FlagsConfiguration,
    { signal }: { signal: AbortSignal }
  ): Promise<void> {
    await waitWithAbort(signal, this.exposureCacheReady)

    const prevCreatedAt = this.flagsConfiguration?.precomputed?.response.data.attributes.createdAt
    const newCreatedAt = newFlagsConfiguration.precomputed?.response.data.attributes.createdAt
    if (prevCreatedAt !== undefined && prevCreatedAt !== newCreatedAt) {
      await waitWithAbort(signal, this.exposureCache?.clear())
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
}
