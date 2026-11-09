import { display } from '@datadog/browser-core'
import {
  type AssignmentCache,
  acknowledgesExperimentationOptOut,
  canonicalizeFlagSelection,
  configMatchesContext,
  evaluatePrecomputedConfiguration,
  experimentationOptOutPolicy,
  type FlagsConfiguration,
  type FlagTypeToValue,
  INVALID_EXPERIMENTATION_OPT_OUT,
} from '@datadog/flagging-core'
import type {
  EvaluationContext,
  FlagValueType,
  Hook,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/web-sdk'
import {
  ErrorCode,
  GeneralError,
  InvalidContextError,
  ProviderEvents,
  ProviderStatus,
  StandardResolutionReasons,
} from '@openfeature/web-sdk'
import { hasIndexedDB } from '../cache/helpers'
import { IndexedDBFlagsCache } from '../cache/indexeddb-flags-cache'
import {
  ASSIGNMENT_AUTHORIZATION_FAILED,
  extractAssignmentToken,
  normalizeAssignmentToken,
} from '../domain/assignment-token'
import {
  type FlaggingConfiguration,
  type FlaggingInitConfiguration,
  validateAndBuildFlaggingConfiguration,
} from '../domain/configuration'
import { createRequestDiagnostics, type FetchTrigger } from '../transport/requestDiagnostics'
import { cloneSigningContext } from '../transport/responseSigning/context'
import { ResponseVerificationError } from '../transport/responseSigning/verification'
import { toProviderErrorEvent } from './error-event'
import {
  bindEvaluationTelemetryResult,
  createEvaluationTelemetryPolicy,
  type EvaluationTelemetryPolicy,
} from './evaluation-telemetry-policy'
import { ExperimentationOptOutMode, getExperimentationOptOutMode } from './experimentation-opt-out'
import { registerDatadogProvider } from './exposure-scope'
import { stampExposureCacheVerdict } from './exposures'
import { createFlagEvaluationTransport, type FlagEvaluationTransport } from './flagEvaluationTransport'
import { createLifecycleTelemetry } from './lifecycleTelemetry'
import { DatadogProviderBase } from './provider-base'
import { createProviderTracking, type ProviderTracking } from './provider-tracking'
import { enrichEvaluationContextWithRumUser } from './rumIntegration'
import { runTrackingLifecycleOperation } from './tracking'

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
export class DatadogProvider extends DatadogProviderBase {
  /** Runtime feature detection for applications adopting the response-signing draft. */
  static readonly responseSigningVersion = 1
  readonly metadata: ProviderMetadata = {
    name: 'datadog',
  }
  hooks?: Hook[]

  /** Provider-level configuration */
  private readonly configuration?: FlaggingConfiguration

  /** Controls both directions of the provider's RUM integration. */
  private readonly isRumIntegrationEnabled: boolean
  private flagEvaluationTransport?: FlagEvaluationTransport
  private lifecycleTelemetry?: ReturnType<typeof createLifecycleTelemetry>
  private initializationStarted = false
  private verificationError: ResponseVerificationError | undefined
  private proofExpirySignaled = false

  // TODO: Migrate this manual context plumbing to a provider `before` hook once
  // @openfeature/web-sdk supports returned EvaluationContext values for web hooks.
  // Watch upstream packages/web/src/hooks/hook.ts for the before return changing from `void`,
  // and packages/web/src/client/internal/open-feature-client.ts for `beforeHooks` merging that
  // result before calling the resolver and subsequent hooks. Return this stored context, not a
  // fresh RUM lookup, so targeting, flag configuration, and telemetry stay on the same identity.
  /** Effective context associated with the active flags configuration. */
  private evaluationContext: EvaluationContext | undefined
  /** Request context used for tracking until a configuration has been accepted. */
  private requestedEvaluationContext: EvaluationContext = {}
  private readonly telemetryPolicy: EvaluationTelemetryPolicy
  private readonly experimentationOptOutMode: ExperimentationOptOutMode

  status: ProviderStatus

  private readonly requestDiagnostics: ReturnType<typeof createRequestDiagnostics>

  // Token-bearing requests and explicit rejections require subject matching.
  // Retain this boundary across failures/close while the old assignments remain.
  private assignmentSubjectIsolationRequired = false
  private flagsConfiguration: FlagsConfiguration | undefined
  // Separate from observation/bootstrap/persistence: only this provider can establish verification.
  private verifiedConfiguration: FlagsConfiguration | undefined
  private flagsCache: IndexedDBFlagsCache | undefined

  private exposureCache: AssignmentCache | undefined
  private exposureCacheReady: Promise<void> | undefined
  private readonly tracking: ProviderTracking

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
   *    operation. Aborted updates delegate to it so all concurrent
   *    updates resolve to the same result. On close, it is replaced
   *    with a settled promise so aborted updates can finish.
   */
  private latestContextUpdate: Promise<void> = Promise.resolve()
  private contextUpdateAbortController: AbortController = new AbortController()

  constructor(options: FlaggingInitConfiguration) {
    super()
    this.experimentationOptOutMode = getExperimentationOptOutMode(options)
    this.requestDiagnostics = createRequestDiagnostics()
    this.configuration = validateAndBuildFlaggingConfiguration(options)
    const getTrackingContext = () => this.effectiveTrackingContext()
    this.telemetryPolicy = createEvaluationTelemetryPolicy(this.metadata, options, getTrackingContext)
    registerDatadogProvider(this.metadata)

    this.isRumIntegrationEnabled = options.enableRumFeatureFlagTracking ?? true
    this.tracking = createProviderTracking({
      options,
      configuration: this.configuration,
      enabledByDefault: true,
      getTransport: () => this.flagEvaluationTransport,
      getTrackingContext,
      telemetryPolicy: this.telemetryPolicy,
    })
    this.hooks = this.tracking.hooks
    this.exposureCache = this.tracking.exposureCache

    if (hasIndexedDB() && this.configuration?.responseSigning?.mode !== 'required') {
      this.flagsCache = new IndexedDBFlagsCache(
        options.clientToken,
        canonicalizeFlagSelection(options.flagSelection).selection,
        this.configuration?.responseSigning?.cacheNamespace
      )
    }

    this.flagsConfiguration =
      this.configuration?.responseSigning?.mode === 'required' ? undefined : options.initialFlagsConfiguration
    this.status = ProviderStatus.NOT_READY
  }

  async initialize(context: EvaluationContext = {}): Promise<void> {
    if (!this.initializationStarted) {
      this.initializationStarted = true
      try {
        if (this.configuration) {
          this.flagEvaluationTransport = createFlagEvaluationTransport(this.configuration)
          this.lifecycleTelemetry = createLifecycleTelemetry(this.configuration, this.flagEvaluationTransport)
        }
      } catch {
        // Diagnostic transport setup must not prevent flag evaluation.
      }
    }
    const telemetry = this.lifecycleTelemetry
    this.exposureCacheReady = this.tracking.initialize()
    try {
      return await this.setContext(context, 'initialization')
    } catch (error) {
      telemetry?.settle('failed')
      throw error
    }
  }

  async onClose(): Promise<void> {
    try {
      this.lifecycleTelemetry?.stop()
    } catch {
      // Diagnostic shutdown must not interrupt application shutdown.
    }
    // Aborted updates must not delegate to their own pending promise during shutdown.
    this.latestContextUpdate = Promise.resolve()
    this.contextUpdateAbortController.abort()
    try {
      await this.tracking.shutdown()
    } finally {
      await runTrackingLifecycleOperation(() => this.flagEvaluationTransport?.stop())
      this.flagEvaluationTransport = undefined
      this.lifecycleTelemetry = undefined
      this.initializationStarted = false
    }
    this.status = ProviderStatus.NOT_READY
  }

  public onContextChange(_oldContext: EvaluationContext, context: EvaluationContext): Promise<void> {
    return this.setContext(context)
  }

  private setContext(context: EvaluationContext, trigger: FetchTrigger = 'context_change'): Promise<void> {
    const { context: targetingContext, assignmentToken: suppliedToken } = extractAssignmentToken(context)
    const assignmentToken = normalizeAssignmentToken(suppliedToken)
    const effectiveContext = this.isRumIntegrationEnabled
      ? enrichEvaluationContextWithRumUser(targetingContext)
      : targetingContext
    // RUM user attributes must never supply or restore an assignment credential.
    const { context: sanitizedContext } = extractAssignmentToken(effectiveContext)
    const evaluationContext: EvaluationContext = this.configuration?.responseSigning
      ? cloneSigningContext(sanitizedContext)
      : sanitizedContext
    // Apply telemetry admission before the ordinary assignment refresh completes.
    this.telemetryPolicy.setContext(evaluationContext)
    this.requestedEvaluationContext = evaluationContext
    this.verificationError = undefined
    // Missing/unusable tokens preserve ordinary no-token behavior, but must not
    // remove a boundary already established by a request or server rejection.
    this.assignmentSubjectIsolationRequired ||= assignmentToken !== undefined

    if (this.status === ProviderStatus.NOT_READY) {
      // we're initializing, no status changes necessary
    } else {
      this.status = ProviderStatus.RECONCILING
      this.events.emit(ProviderEvents.Reconciling)
    }

    // abort any previous setContext operation
    this.contextUpdateAbortController.abort(
      new DOMException('Flag configuration fetch superseded by a newer context update', 'AbortError')
    )
    this.contextUpdateAbortController = new AbortController()

    const signal = this.contextUpdateAbortController.signal
    this.requestDiagnostics.accept(signal, trigger)

    // Important: OF SDK awaits for all onContextChange calls to exit
    // before marking the provider as ready. Make sure to respect
    // `signal`, so we don't block OF SDK unnecessarily.
    this.latestContextUpdate = this.retrieveFlagsConfiguration(evaluationContext, { signal, assignmentToken })
      .then((result) =>
        // Preserve the existing timestamp-based reset for experiment reporting.
        // createdAt is a configuration timestamp, not an experiment revision.
        this.maybeClearExposureCache(result.config, { signal }).then(
          () => result,
          // Ignore exposure cache errors. They should not prevent us from using the latest configuration.
          () => result
        )
      )
      .then(
        ({ config, fromCache }) => {
          if (signal.aborted) {
            // Follow the newer update, or the settled promise installed by onClose.
            return this.latestContextUpdate
          }

          // If we get to here, we're the latest context update
          // call. We should update our state atomically here in a
          // single microtask (i.e., without any await/promise
          // scheduling).

          if (
            this.configuration?.responseSigning?.mode === 'required' &&
            !this.configuration.responseSigning.isVerified(config, evaluationContext)
          ) {
            this.status = ProviderStatus.ERROR
            const error = new ResponseVerificationError('expired-proof')
            this.verificationError = error
            this.events.emit(ProviderEvents.Error, toProviderErrorEvent(error))
            throw error
          }
          const recoveredFromExpiry = this.proofExpirySignaled
          this.proofExpirySignaled = false
          this.flagsConfiguration = config
          if (this.configuration?.responseSigning?.isVerified(config, evaluationContext))
            this.verifiedConfiguration = config
          this.assignmentSubjectIsolationRequired = false
          // Same-subject fallback can have older attributes. Keep its original
          // context for evaluation and telemetry; do not relabel or re-cache it.
          this.evaluationContext = fromCache ? (config.precomputed?.context ?? evaluationContext) : evaluationContext
          this.status = fromCache ? ProviderStatus.STALE : ProviderStatus.READY
          // Report fallback errors only after the update survives cache reconciliation.
          if (fromCache) this.lifecycleTelemetry?.providerError()
          this.lifecycleTelemetry?.settle(config.precomputed ? (fromCache ? 'cached_fallback' : 'ready') : 'failed')
          this.events.emit(ProviderEvents.ConfigurationChanged)
          if (recoveredFromExpiry && !fromCache) this.events.emit(ProviderEvents.Ready)

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
            // Follow the newer update, or the settled promise installed by onClose.
            return this.latestContextUpdate
          } else {
            // Otherwise, this is a legitimate error
            this.verificationError = error instanceof ResponseVerificationError ? error : undefined
            this.assignmentSubjectIsolationRequired ||=
              error instanceof GeneralError && error.message === ASSIGNMENT_AUTHORIZATION_FAILED
            this.status = ProviderStatus.ERROR
            this.events.emit(ProviderEvents.Error, toProviderErrorEvent(error))
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
    { signal, assignmentToken }: { signal: AbortSignal; assignmentToken?: unknown }
  ): Promise<{ config: FlagsConfiguration; fromCache: boolean }> {
    if (!this.configuration) {
      throw new Error('Invalid configuration')
    }
    const optedOut = experimentationOptOutPolicy(context, this.experimentationOptOutMode)
    if (optedOut === undefined) throw new InvalidContextError(INVALID_EXPERIMENTATION_OPT_OUT)
    const signing = this.configuration.responseSigning
    let allowSameSubject = this.assignmentSubjectIsolationRequired
    const canUse = (config: FlagsConfiguration | undefined) =>
      this.canUseConfiguration(config, context, allowSameSubject) &&
      (signing?.mode !== 'required' || signing.isVerified(config, context))
    const retainedConfig = this.flagsConfiguration

    // Prefer verified memory, then current config, before persistent cache.
    const cachedConfigPromise =
      signing?.isVerified(this.verifiedConfiguration, context) && canUse(this.verifiedConfiguration)
        ? Promise.resolve(this.verifiedConfiguration)
        : canUse(retainedConfig)
          ? Promise.resolve(retainedConfig)
          : this.flagsCache?.get(context, optedOut)

    try {
      const config = await this.configuration.fetchFlagsConfiguration(context, { signal, assignmentToken })
      signal.throwIfAborted()
      if (signing?.mode === 'required' && !signing.isVerified(config, context))
        throw new ResponseVerificationError('expired-proof')
      if (config.precomputed) {
        this.lifecycleTelemetry?.configurationReceived()
      } else if (config.precomputedError) {
        this.lifecycleTelemetry?.providerError()
      }
      this.flagsCache?.set(config, context, optedOut, signal)
      return { config, fromCache: false }
    } catch (err) {
      if (!signal.aborted && err instanceof GeneralError && err.message === ASSIGNMENT_AUTHORIZATION_FAILED) {
        display.warn(`Assignment download failed: ${ASSIGNMENT_AUTHORIZATION_FAILED}`)
        allowSameSubject = true
      }
      // Try to recover with current/cached config
      try {
        const fallback =
          signing?.isVerified(this.verifiedConfiguration, context) && canUse(this.verifiedConfiguration)
            ? this.verifiedConfiguration
            : canUse(retainedConfig)
              ? retainedConfig
              : cachedConfigPromise
        const config = await waitWithAbort(signal, fallback)
        if (config && canUse(config)) {
          return { config, fromCache: true }
        }
      } catch (err) {}

      if (!signal.aborted) this.lifecycleTelemetry?.providerError()
      throw err
    }
  }

  private canUseConfiguration(
    config: FlagsConfiguration | undefined,
    context: EvaluationContext,
    allowSameSubject = false
  ): boolean {
    const optedOut = experimentationOptOutPolicy(context, this.experimentationOptOutMode)
    const storedContext = config?.precomputed?.context
    const matches = allowSameSubject
      ? typeof storedContext?.targetingKey === 'string' &&
        storedContext.targetingKey === context.targetingKey &&
        (this.experimentationOptOutMode === ExperimentationOptOutMode.Disabled || configMatchesContext(config, context))
      : configMatchesContext(config, context)
    return (
      optedOut !== undefined &&
      matches &&
      (!optedOut || config?.precomputed?.context !== undefined) &&
      acknowledgesExperimentationOptOut(config, optedOut)
    )
  }

  private effectiveTrackingContext(): EvaluationContext {
    return this.experimentationOptOutMode !== ExperimentationOptOutMode.Disabled
      ? this.requestedEvaluationContext
      : (this.evaluationContext ?? this.requestedEvaluationContext)
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

  protected resolve<T extends FlagValueType>(
    type: T,
    flagKey: string,
    defaultValue: FlagTypeToValue<T>,
    _context: EvaluationContext,
    _logger: Logger
  ): ResolutionDetails<FlagTypeToValue<T>> {
    if (
      this.assignmentSubjectIsolationRequired &&
      experimentationOptOutPolicy(this.requestedEvaluationContext, this.experimentationOptOutMode) !== undefined &&
      !this.canUseConfiguration(this.flagsConfiguration, this.requestedEvaluationContext, true)
    ) {
      return bindEvaluationTelemetryResult(
        { value: defaultValue, reason: 'ERROR', errorCode: ErrorCode.GENERAL },
        this.telemetryPolicy,
        this.requestedEvaluationContext
      )
    }
    const optOutEnabled = this.experimentationOptOutMode !== ExperimentationOptOutMode.Disabled
    const context = optOutEnabled ? this.requestedEvaluationContext : (this.evaluationContext ?? {})
    const signing = this.configuration?.responseSigning
    const unverified =
      signing?.mode === 'required' && !signing.isVerified(this.flagsConfiguration, this.requestedEvaluationContext)
    const expired = unverified && signing.isExpired(this.flagsConfiguration, this.requestedEvaluationContext)
    const expiryMessage = 'The verified flag configuration proof has expired'
    if (
      expired &&
      !this.proofExpirySignaled &&
      (this.status === ProviderStatus.READY || this.status === ProviderStatus.STALE)
    ) {
      this.proofExpirySignaled = true
      this.status = ProviderStatus.ERROR
      this.events.emit(ProviderEvents.Error, toProviderErrorEvent(new GeneralError(expiryMessage)))
    }
    const verificationMessage = expired ? expiryMessage : unverified ? this.verificationError?.message : undefined
    const result: ResolutionDetails<FlagTypeToValue<T>> = verificationMessage
      ? {
          value: defaultValue,
          reason: StandardResolutionReasons.ERROR,
          errorCode: ErrorCode.GENERAL,
          errorMessage: verificationMessage,
        }
      : evaluatePrecomputedConfiguration(
          unverified ? undefined : this.flagsConfiguration,
          type,
          flagKey,
          defaultValue,
          context,
          this.experimentationOptOutMode,
          _logger
        )
    // A well-formed context is waiting for usable assignments, not invalid.
    const awaitingAssignments =
      optOutEnabled &&
      result.errorCode === ErrorCode.INVALID_CONTEXT &&
      experimentationOptOutPolicy(context, this.experimentationOptOutMode) !== undefined
    const boundResult = awaitingAssignments
      ? {
          ...result,
          errorCode: ErrorCode.PROVIDER_NOT_READY,
          errorMessage: 'Assignments for the current evaluation context are not available',
        }
      : result
    // Prepare the exposure decision before the SDK freezes the metadata for
    // hooks: the one verdict shared by the Datadog path and the customer hook.
    stampExposureCacheVerdict({ ...boundResult, flagKey }, this.effectiveTrackingContext(), this.exposureCache)
    // Bind the evaluated context (for example the RUM-enriched subject) to
    // successful results so customer hooks read the same identity the exposure
    // event reports. Error results without metadata keep their existing shape.
    return bindEvaluationTelemetryResult(
      boundResult,
      this.telemetryPolicy,
      optOutEnabled || boundResult.flagMetadata !== undefined ? context : undefined
    )
  }
}
