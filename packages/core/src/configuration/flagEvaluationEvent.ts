import type { FlagEvaluationEvent } from './flagEvaluationEvent.types'
import type { EvaluationContextValue } from '@openfeature/core'

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

export function createFlagEvaluationEvent(data: FlagEvaluationAggregationData, timestamp: number): FlagEvaluationEvent {
  const event: FlagEvaluationEvent = {
    flag: {
      key: data.flagKey,
    },
    first_evaluation: data.firstEvaluation,
    last_evaluation: data.lastEvaluation,
    evaluation_count: data.count,
    runtime_default_used: data.runtimeDefaultUsed,
    timestamp,
  }

  if (data.targetingKey) {
    event.targeting_key = data.targetingKey
  }

  if (data.error) {
    event.error = { message: data.error }
  }

  if (data.variantKey) {
    event.variant = { key: data.variantKey }
  }

  if (data.allocationKey) {
    event.allocation = { key: data.allocationKey }
  }

  if (data.targetingRuleKey) {
    event.targeting_rule = { key: data.targetingRuleKey }
  }

  return event
}