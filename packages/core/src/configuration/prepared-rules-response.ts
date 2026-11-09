import type { FlagValue, Logger } from '@openfeature/core'
import { EvaluatorParams } from './evaluator-params'
import type { Allocation, Flag, FlagsConfiguration as ProtobufFlagsConfiguration } from './generated/ufc_pb'
import { type PreparedAllocations, prepareAllocations } from './prepared-activation'

export type CachedJsonValue = { valid: true; value: FlagValue } | { valid: false }

export type PreparedRulesResponse = ProtobufFlagsConfiguration & {
  preparedEvaluatorParams: EvaluatorParams
  evaluationRegexCache: Map<number, RegExp | null>
  evaluationJsonCache: Map<number, CachedJsonValue>
  /** Validated once at decode time; evaluation must not read raw activation timestamps. */
  randomizationActivations: ReadonlyMap<Flag, PreparedAllocations<Allocation>>
}

export function prepareRulesResponse(
  response: ProtobufFlagsConfiguration,
  logger: Pick<Logger, 'warn'> = console
): PreparedRulesResponse {
  const prepared = response as PreparedRulesResponse
  const hasEvaluatorParams = Object.prototype.hasOwnProperty.call(prepared, 'preparedEvaluatorParams')
  const hasRegexCache = Object.prototype.hasOwnProperty.call(prepared, 'evaluationRegexCache')
  const hasJsonCache = Object.prototype.hasOwnProperty.call(prepared, 'evaluationJsonCache')
  const hasRandomizationActivations = Object.prototype.hasOwnProperty.call(prepared, 'randomizationActivations')
  if (hasEvaluatorParams && hasRegexCache && hasJsonCache && hasRandomizationActivations) return prepared

  let randomizationActivations: ReadonlyMap<Flag, PreparedAllocations<Allocation>> | undefined
  if (!hasRandomizationActivations) {
    const activations = new Map<Flag, PreparedAllocations<Allocation>>()
    for (const flag of Object.values(response.flags)) {
      activations.set(
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
    randomizationActivations = activations
  }

  Object.defineProperties(prepared, {
    ...(hasEvaluatorParams
      ? {}
      : { preparedEvaluatorParams: { value: EvaluatorParams.fromProtobufConfiguration(response, logger) } }),
    ...(hasRegexCache ? {} : { evaluationRegexCache: { value: new Map<number, RegExp | null>() } }),
    ...(hasJsonCache ? {} : { evaluationJsonCache: { value: new Map<number, CachedJsonValue>() } }),
    ...(hasRandomizationActivations ? {} : { randomizationActivations: { value: randomizationActivations } }),
  })
  return prepared
}
