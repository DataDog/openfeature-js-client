import type { EvaluationContext, EvaluationContextValue, EvaluationDetails, FlagValue } from '@openfeature/core'
import { getMD5Hash } from '../obfuscation'
import { createFlagEvaluationEvent } from './flagEvaluationEvent'
import type { FlagEvaluationEvent } from './flagEvaluationEvent.types'

interface FlagEvaluationAggregationData {
  flagKey: string
  variantKey?: string
  allocationKey?: string
  targetingRuleKey?: string
  targetingKey?: string
  targetingContext?: Record<string, EvaluationContextValue>
  count: number
  firstEvaluation: number
  lastEvaluation: number
  runtimeDefaultUsed: boolean
  error?: string
}

const DEFAULT_FLAG_EVALUATION_TRACKING_INTERVAL = 10000

export class FlagEvaluationAggregator {
  private aggregatedData = new Map<string, FlagEvaluationAggregationData>()
  private intervalId?: NodeJS.Timeout
  private readonly flushInterval: number
  private readonly onFlush: (events: FlagEvaluationEvent[]) => void

  constructor(
    flushInterval: number = DEFAULT_FLAG_EVALUATION_TRACKING_INTERVAL,
    onFlush: (events: FlagEvaluationEvent[]) => void
  ) {
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
    const keyString = this.createAggregationKeyString(context, details)
    const timestamp = Date.now()

    const existingData = this.aggregatedData.get(keyString)
    if (existingData) {
      existingData.count++
      existingData.lastEvaluation = timestamp
      if (error) {
        existingData.error = error
      }
    } else {
      const runtimeDefaultUsed = details.reason === 'DEFAULT' || details.reason === 'ERROR'
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

    const events = Array.from(this.aggregatedData.values()).map((data) => createFlagEvaluationEvent(data, data.firstEvaluation))
    this.aggregatedData.clear()
    this.onFlush(events)
  }

  private createAggregationKeyString<T extends FlagValue>(
    context: EvaluationContext,
    details: EvaluationDetails<T>
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
      })
    )
  }
}
