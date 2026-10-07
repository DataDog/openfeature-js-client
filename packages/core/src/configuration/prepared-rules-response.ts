import type { FlagValue } from '@openfeature/core'
import type { FlagsConfiguration as ProtobufFlagsConfiguration } from './generated/ufc_pb'

export type CachedJsonValue = { valid: true; value: FlagValue } | { valid: false }

export type PreparedRulesResponse = ProtobufFlagsConfiguration & {
  evaluationRegexCache: Map<number, RegExp | null>
  evaluationJsonCache: Map<number, CachedJsonValue>
}

export function prepareRulesResponse(response: ProtobufFlagsConfiguration): PreparedRulesResponse {
  const prepared = response as PreparedRulesResponse
  if (prepared.evaluationRegexCache && prepared.evaluationJsonCache) return prepared

  Object.defineProperties(prepared, {
    evaluationRegexCache: { value: new Map<number, RegExp | null>() },
    evaluationJsonCache: { value: new Map<number, CachedJsonValue>() },
  })
  return prepared
}
