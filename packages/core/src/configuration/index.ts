import { configurationFromPrecomputedString, configurationToPrecomputedString } from './precomputed-wire'

export * from './configuration'
export * from './exposureEvent'
export * from './exposureEvent.types'
export * from './flagEvaluationAggregator'
export * from './flagEvaluationEvent'
export * from './flagEvaluationEvent.types'

/** @deprecated Import from `@datadog/flagging-core/precomputed` instead. */
export const configurationFromString = configurationFromPrecomputedString

/** @deprecated Import from `@datadog/flagging-core/precomputed` instead. */
export const configurationToString = configurationToPrecomputedString
