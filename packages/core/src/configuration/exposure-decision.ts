import type { EvaluationDetails, FlagMetadata, FlagValue } from '@openfeature/core'
import type { AssignmentCache } from '../cache'
import type { ExposureEvent } from './exposureEvent.types'

const EXPOSURE_CACHE_HIT_METADATA_KEY = '__dd_exposure_cache_hit'

const decisions = new WeakMap<object, () => void>()

/**
 * Prepare the exposure-cache verdict as a provisional, enumerable getter on the
 * metadata, before OpenFeature freezes it for hooks. The verdict becomes final
 * only when the evaluation completes successfully, so concurrent or nested
 * evaluations cannot both record the same exposure.
 */
export function prepareExposureDecision(metadata: FlagMetadata, cache: AssignmentCache, event: ExposureEvent): void {
  let hit = cache.has(event)
  let completed = false
  Object.defineProperty(metadata, EXPOSURE_CACHE_HIT_METADATA_KEY, {
    enumerable: true,
    get: () => hit,
  })
  decisions.set(metadata, () => {
    if (completed) return
    hit = cache.has(event)
    if (!hit) cache.set(event)
    completed = true
  })
}

/**
 * Admit once after a successful evaluation, before either destination observes
 * the verdict. Returns true when a shared decision was prepared for the result,
 * so callers know recording has been handled.
 */
export function completeExposureDecision(
  details: Pick<EvaluationDetails<FlagValue>, 'flagMetadata' | 'errorCode' | 'reason'>
): boolean {
  if (details.errorCode || details.reason === 'ERROR') return false
  const complete = details.flagMetadata && decisions.get(details.flagMetadata)
  if (!complete) return false
  complete()
  return true
}
