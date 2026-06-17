import type { EvaluationContextValue } from '@openfeature/core'
import type { TimeStamp } from '@datadog/js-core/time'

export interface FlagEvaluationEvent {
  flag: {
    key: string
  }
  first_evaluation: TimeStamp
  last_evaluation: TimeStamp
  evaluation_count: number
  runtime_default_used: boolean
  timestamp: TimeStamp
  targeting_key?: string
  error?: {
    message: string
  }
  variant?: {
    key: string
  }
  allocation?: {
    key: string
  }
  targeting_rule?: {
    key: string
  }
  context?: {
    evaluation?: Record<string, EvaluationContextValue>
    dd?: {
      service?: string
      rum?: {
        application?: {
          id?: string
        }
        view?: {
          url?: string
        }
      }
    }
  }
}

export interface FlagEvaluationAggregationKey {
  flagKey: string
  variantKey?: string
  allocationKey?: string
  targetingRuleKey?: string
  targetingKey?: string
  targetingContext?: Record<string, EvaluationContextValue>
}

export interface FlagEvaluationAggregationData {
  key: FlagEvaluationAggregationKey
  count: number
  firstEvaluation: TimeStamp
  lastEvaluation: TimeStamp
  runtimeDefaultUsed: boolean
  error?: string
}
