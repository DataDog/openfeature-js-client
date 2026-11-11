import type { FlagValue } from '@openfeature/core'
import type { Allocation, Flag, FlagsConfiguration as ProtobufFlagsConfiguration } from './generated/ufc_pb'
import { type PreparedAllocations, prepareAllocations } from './prepared-activation'

export type CachedJsonValue = { valid: true; value: FlagValue } | { valid: false }

export type PreparedRulesResponse = ProtobufFlagsConfiguration & {
  evaluationRegexCache: Map<number, RegExp | null>
  evaluationJsonCache: Map<number, CachedJsonValue>
  /** Validated once at decode time; evaluation must not read raw activation timestamps. */
  randomizationActivations: ReadonlyMap<Flag, PreparedAllocations<Allocation>>
}

export function prepareRulesResponse(response: ProtobufFlagsConfiguration): PreparedRulesResponse {
  const prepared = response as PreparedRulesResponse
  if (prepared.evaluationRegexCache && prepared.evaluationJsonCache && prepared.randomizationActivations)
    return prepared

  const randomizationActivations = new Map<Flag, PreparedAllocations<Allocation>>()
  for (const flag of Object.values(response.flags)) {
    randomizationActivations.set(
      flag,
      prepareAllocations(flag.allocations, (allocation) => {
        const activation = allocation.randomizationActivatedAt
        if (!activation) return { kind: 'missing' }
        const seconds = Number(activation.seconds)
        const nanos = activation.nanos
        if (
          !Number.isSafeInteger(seconds) ||
          seconds < -62135596800 ||
          seconds > 253402300799 ||
          !Number.isInteger(nanos) ||
          nanos < 0 ||
          nanos >= 1e9
        )
          return { kind: 'invalid' }
        return { kind: 'valid', instant: { seconds, fraction: String(nanos).padStart(9, '0').replace(/0+$/, '') } }
      })
    )
  }

  Object.defineProperties(prepared, {
    evaluationRegexCache: { value: new Map<number, RegExp | null>() },
    evaluationJsonCache: { value: new Map<number, CachedJsonValue>() },
    randomizationActivations: { value: randomizationActivations },
  })
  return prepared
}
