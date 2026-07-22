import type { PrecomputedFlagMetadata } from '../configuration'
import type { TimeStamp } from '../time'

export function createEvaluationTimestampMetadata(evaluationTimestampMs: TimeStamp): PrecomputedFlagMetadata {
  return { __dd_eval_timestamp_ms: evaluationTimestampMs } as PrecomputedFlagMetadata
}
