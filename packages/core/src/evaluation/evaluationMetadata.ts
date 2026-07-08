import type { TimeStamp } from '@datadog/js-core/time'
import type { PrecomputedFlagMetadata } from '../configuration'

export function createEvaluationTimestampMetadata(evaluationTimestampMs: TimeStamp): PrecomputedFlagMetadata {
  return { __dd_eval_timestamp_ms: evaluationTimestampMs } as PrecomputedFlagMetadata
}
