import type { PrecomputedFlagMetadata } from '../configuration'
import type { TimeStamp } from '../time'

export function createEvaluationMetadata(
  evaluationTimestampMs: TimeStamp,
  observeFullEvaluationData: unknown
): PrecomputedFlagMetadata {
  return {
    __dd_eval_timestamp_ms: evaluationTimestampMs,
    __dd_observe_full_evaluation_data: observeFullEvaluationData === true,
  }
}

export function createEvaluationTimestampMetadata(evaluationTimestampMs: TimeStamp): PrecomputedFlagMetadata {
  return { __dd_eval_timestamp_ms: evaluationTimestampMs } as PrecomputedFlagMetadata
}
