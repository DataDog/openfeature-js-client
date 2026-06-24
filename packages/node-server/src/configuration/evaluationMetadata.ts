import type { PrecomputedFlagMetadata } from '@datadog/flagging-core'
import type { TimeStamp } from '@datadog/js-core/time'

export function createEvaluationTimestampMetadata(evaluationTimestampMs: TimeStamp): PrecomputedFlagMetadata {
  return { __dd_eval_timestamp_ms: evaluationTimestampMs } as PrecomputedFlagMetadata
}
