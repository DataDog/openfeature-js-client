import { type FeatureValue, featuresWithPrefix, METADATA_FEATURE_PREFIX } from '@datadog/flagging-core'
import type { EvaluationContext, EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/web-sdk'

const METADATA_ALLOCATION_KEY = '__dd_allocation_key'
const METADATA_DO_LOG = '__dd_do_log'
const METADATA_EXPOSURE_CACHE_HIT = '__dd_exposure_cache_hit'

/**
 * A completed flag evaluation and its Datadog exposure decision.
 */
export interface ExposureEvaluation {
  /** The flag key. */
  readonly flagKey: string
  /** The flag key, variant, value, error and flag metadata of the evaluation. */
  readonly details: EvaluationDetails<FlagValue>
  /** The selected variant key, or undefined when the default value was returned. */
  readonly variant: string | undefined
  /** The key of the selected allocation, or undefined when none was selected. */
  readonly allocation: string | undefined
  /** The evaluation context, including the targeting key. */
  readonly context: EvaluationContext | undefined
  /** The targeting key of the evaluation context, if readable. */
  readonly targetingKey: string | undefined
  /**
   * True when the evaluation succeeded and selected an allocation that logs
   * exposures, whether or not this subject was already exposed.
   */
  isExposure(): boolean
  /**
   * True when this exposure repeats one already recorded for this subject:
   * same allocation, variant and serial id. False for a new or changed
   * exposure, and for an evaluation that is not an exposure.
   */
  isCacheHit(): boolean
  /** True for a new or changed exposure: the decision the provider uses for Datadog. */
  shouldSend(): boolean
  /**
   * The HOOK features of the selected split, keyed without prefix (for example
   * `holdout.key`). Values are a string, number or boolean. Read-only; empty
   * when the split has none.
   */
  getFeatures(): Readonly<Record<string, FeatureValue>>
}

class ExposureEvaluationImpl implements ExposureEvaluation {
  readonly flagKey: string
  readonly details: EvaluationDetails<FlagValue>
  private readonly evaluationContext: EvaluationContext | undefined

  constructor(hookContext: HookContext, details: EvaluationDetails<FlagValue>) {
    this.flagKey = hookContext?.flagKey ?? details.flagKey
    this.details = details
    // A wrapper may expose an unreadable context; the exposure decision below never reads it.
    try {
      this.evaluationContext = hookContext?.context
    } catch {
      this.evaluationContext = undefined
    }
  }

  get variant(): string | undefined {
    return this.details.variant
  }

  get allocation(): string | undefined {
    const allocationKey = this.details.flagMetadata?.[METADATA_ALLOCATION_KEY]
    return typeof allocationKey === 'string' ? allocationKey : undefined
  }

  get context(): EvaluationContext | undefined {
    return this.evaluationContext
  }

  get targetingKey(): string | undefined {
    const targetingKey = this.evaluationContext?.targetingKey
    return typeof targetingKey === 'string' ? targetingKey : undefined
  }

  isExposure(): boolean {
    return (
      this.details.errorCode === undefined &&
      this.details.variant != null &&
      typeof this.allocation === 'string' &&
      this.details.flagMetadata?.[METADATA_DO_LOG] === true
    )
  }

  isCacheHit(): boolean {
    return this.isExposure() && this.details.flagMetadata?.[METADATA_EXPOSURE_CACHE_HIT] === true
  }

  shouldSend(): boolean {
    return this.isExposure() && this.details.flagMetadata?.[METADATA_EXPOSURE_CACHE_HIT] === false
  }

  getFeatures(): Readonly<Record<string, FeatureValue>> {
    return Object.freeze(featuresWithPrefix(this.details.flagMetadata, METADATA_FEATURE_PREFIX) ?? {})
  }
}

/**
 * An OpenFeature hook that hands each completed flag evaluation to a callback,
 * with the Datadog exposure decision, so an application can record exposures in
 * its own data store.
 *
 * This hook is optional. The provider puts the same data in the flag metadata,
 * so any OpenFeature hook can read it. This class reads it for you.
 *
 * Register it with `OpenFeature.addHooks(new ExposureHook(callback))` or on a
 * client. The callback runs for every evaluation, including errors and repeats.
 * Use `shouldSend()` to keep the new or changed exposures.
 *
 * When exposure logging to Datadog is on, these are exactly the exposures
 * Datadog sends. With `trackExposures: false`, Datadog receives no exposures,
 * and `shouldSend()` gives the same results.
 *
 * The callback runs on the evaluation thread: hand the data to a background
 * queue instead of doing I/O in the callback. An exception from the callback
 * does not affect the evaluation. The first one is logged at warn level, later
 * ones at debug level.
 */
export class ExposureHook implements Hook {
  private readonly callback: (evaluation: ExposureEvaluation) => void
  private warned = false

  constructor(callback: (evaluation: ExposureEvaluation) => void) {
    if (typeof callback !== 'function') {
      throw new TypeError('ExposureHook requires a callback function')
    }
    this.callback = callback
  }

  /** Runs in the final hook stage, so a later hook's error is seen. */
  finally(hookContext: HookContext, evaluationDetails: EvaluationDetails<FlagValue>): void {
    if (evaluationDetails == null) return
    try {
      this.callback(new ExposureEvaluationImpl(hookContext, evaluationDetails))
    } catch (error) {
      if (this.warned) {
        console.debug('Exposure callback failed', error)
      } else {
        this.warned = true
        console.warn('Exposure callback failed; later failures are logged at debug level', error)
      }
    }
  }
}
