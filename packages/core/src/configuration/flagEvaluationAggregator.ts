import type { EvaluationContext, EvaluationContextValue, EvaluationDetails, FlagValue } from '@openfeature/core'
import { getMD5Hash } from '../obfuscation'
import { type TimeStamp, timeStampNow } from '../time'
import { createFlagEvaluationEvent } from './flagEvaluationEvent'
import type { FlagEvaluationEvent } from './flagEvaluationEvent.types'

const EVALUATION_TIMESTAMP_METADATA_KEY = '__dd_eval_timestamp_ms'

interface FlagEvaluationAggregationData {
  flagKey: string
  variantKey?: string
  allocationKey?: string
  targetingRuleKey?: string
  targetingKey?: string
  targetingContext?: Record<string, EvaluationContextValue>
  count: number
  firstEvaluation: TimeStamp
  lastEvaluation: TimeStamp
  runtimeDefaultUsed: boolean
  error?: string
}

export class FlagEvaluationAggregator {
  private aggregatedData = new Map<string, FlagEvaluationAggregationData>()
  private intervalId?: NodeJS.Timeout
  private readonly flushInterval: number
  private readonly onFlush: (events: FlagEvaluationEvent[]) => void

  constructor(flushInterval: number, onFlush: (events: FlagEvaluationEvent[]) => void) {
    this.flushInterval = flushInterval
    this.onFlush = onFlush
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.flush()
    }, this.flushInterval)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.flush()
  }

  addEvaluation<T extends FlagValue>(context: EvaluationContext, details: EvaluationDetails<T>, error?: string): void {
    const keyString = this.createAggregationKeyString(context, details, error)
    const timestamp = getEvaluationTimestamp(details)

    const existingData = this.aggregatedData.get(keyString)
    if (existingData) {
      existingData.count++
      existingData.lastEvaluation = timestamp
      if (error) {
        existingData.error = error
      }
    } else {
      const runtimeDefaultUsed = isRuntimeDefaultUsed(details)
      const allocationKey = details.flagMetadata?.allocationKey as string
      const targetingRuleKey = details.flagMetadata?.targetingRuleKey as string
      const { targetingKey, ...targetingContext } = context

      this.aggregatedData.set(keyString, {
        flagKey: details.flagKey,
        variantKey: details.variant,
        allocationKey,
        targetingRuleKey,
        targetingKey,
        targetingContext,
        count: 1,
        firstEvaluation: timestamp,
        lastEvaluation: timestamp,
        runtimeDefaultUsed,
        error,
      })
    }
  }

  flush(): void {
    if (this.aggregatedData.size === 0) {
      return
    }

    const flushTimestamp = timeStampNow()
    const events = Array.from(this.aggregatedData.values()).map((data) =>
      createFlagEvaluationEvent(data, flushTimestamp)
    )
    this.aggregatedData.clear()
    this.onFlush(events)
  }

  private createAggregationKeyString<T extends FlagValue>(
    context: EvaluationContext,
    details: EvaluationDetails<T>,
    error?: string
  ): string {
    const allocationKey = details.flagMetadata?.allocationKey as string
    const targetingRuleKey = details.flagMetadata?.targetingRuleKey as string
    const { targetingKey, ...targetingContext } = context

    // Hash the deterministic object representation
    return getMD5Hash(
      JSON.stringify({
        flagKey: details.flagKey,
        variant: details.variant || '',
        allocationKey: allocationKey || '',
        targetingRuleKey: targetingRuleKey || '',
        targetingKey: targetingKey || '',
        targetingContext,
        error: error || '',
      })
    )
  }
}

function getEvaluationTimestamp<T extends FlagValue>(details: EvaluationDetails<T>): TimeStamp {
  const metadataTimestamp = details.flagMetadata?.[EVALUATION_TIMESTAMP_METADATA_KEY]
  return Number.isFinite(metadataTimestamp) ? (metadataTimestamp as TimeStamp) : timeStampNow()
}

function isRuntimeDefaultUsed<T extends FlagValue>(details: EvaluationDetails<T>): boolean {
  // Datadog-assigned evaluations attach a platform variation key to OpenFeature
  // details.variant. Browser precomputed flags model variationKey as a string, and
  // server UFC variants are keyed by string. Default/error fallback paths omit the
  // variant, so nullish variant is the SDK-visible signal that the caller's default
  // value was returned.
  return details.variant == null
}
