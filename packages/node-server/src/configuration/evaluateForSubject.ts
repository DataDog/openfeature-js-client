import type { FlagTypeToValue } from '@datadog/flagging-core'
import {
  type EvaluationContext,
  type FlagValueType,
  type Logger,
  TargetingKeyMissingError,
} from '@openfeature/server-sdk'
import { findMatchingRuleIndex } from '../rules/rules'
import { matchesShard } from '../shards/matchesShard'
import { type Flag, type Split, type VariantType, variantTypeToFlagValueType } from './ufc-v1'
import {
  AllocationOutcomeCode,
  DDFlagEvaluationDetailsBuilder,
  type DDFlagEvaluationDetails,
  FlagEvaluationOutcomeCode,
} from './flagEvaluationDetails'

export function evaluateForSubject<T extends FlagValueType>(
  flag: Flag,
  type: T,
  subjectKey: string | null | undefined,
  subjectAttributes: EvaluationContext,
  defaultValue: FlagTypeToValue<T>,
  logger: Logger,
  configFetchedAt: string | null,
  environmentName: string | null,
): DDFlagEvaluationDetails<FlagTypeToValue<T>> {
  const builder = new DDFlagEvaluationDetailsBuilder(
    flag.key, flag.allocations, configFetchedAt, environmentName,
  )

  if (!flag.enabled) {
    logger.debug(`returning default assignment because flag is disabled`, {
      flagKey: flag.key,
      subjectKey,
    })
    return builder.build(defaultValue, FlagEvaluationOutcomeCode.DISABLED,
      'Flag is disabled', flag.variationType)
  }

  const isValid = validateTypeMatch(type, flag.variationType)
  if (!isValid) {
    logger.debug(`variant value type mismatch, returning default value`, {
      flagKey: flag.key,
      subjectKey,
      expectedType: type,
      variantType: flag.variationType,
    })
    return builder.build(
      defaultValue,
      FlagEvaluationOutcomeCode.TYPE_MISMATCH,
      `Expected type '${type}' does not match flag variationType '${flag.variationType}'`,
      flag.variationType,
    )
  }

  const now = new Date()
  for (const [index, allocation] of flag.allocations.entries()) {
    const position = index + 1 // 1-indexed

    if (allocation.startAt && now < new Date(allocation.startAt as unknown as string)) {
      logger.debug(`allocation before start date`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
        startAt: allocation.startAt,
      })
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.BEFORE_START_TIME)
      continue
    }

    if (allocation.endAt && now >= new Date(allocation.endAt as unknown as string)) {
      logger.debug(`allocation after end date`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
        endAt: allocation.endAt,
      })
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.AFTER_END_TIME)
      continue
    }

    const ruleMatchIndex = findMatchingRuleIndex(allocation.rules, subjectAttributes)
    if (ruleMatchIndex === null) {
      // rules present but none matched
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.RULES_MISMATCH)
      continue
    }
    // ruleMatchIndex is a number (matched rule) or undefined (no rules, implicit match-all)

    const selectedSplit = selectSplitUsingSharding(allocation.splits, subjectKey, flag.key, logger)
    if (!selectedSplit) {
      logger.debug(`no matching split found for subject`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
      })
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.TRAFFIC_MISS, ruleMatchIndex)
      continue
    }

    const variant = flag.variations[selectedSplit.variationKey]
    if (!variant) {
      // Intentional continue: we mirror the pre-RFC behavior of falling through on a
      // corrupt allocation rather than hard-failing. The subject has already passed rules
      // and sharding for this allocation, so a later allocation may produce a different
      // MATCH — MISSING_VARIATION in unmatchedAllocations signals that corruption occurred.
      // See RFC open question #4 for the trade-offs of hard-failing vs. continuing.
      logger.warn('Split references unknown variationKey', {
        flagKey: flag.key, allocationKey: allocation.key,
        variationKey: selectedSplit.variationKey,
      })
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.MISSING_VARIATION, ruleMatchIndex)
      continue
    }

    logger.debug(`evaluated a flag`, {
      flagKey: flag.key,
      subjectKey,
      assignment: variant.value,
    })

    // variant.key is the variation's own .key field, which should equal selectedSplit.variationKey
    // (the key used to look it up in flag.variations). In well-formed config these are identical.
    // Using variant.key mirrors the pre-RFC behavior (ResolutionDetails.variant = variant.key).
    builder.recordMatch(allocation, position, variant.key, ruleMatchIndex)
    return builder.build(
      variant.value as FlagTypeToValue<T>,
      FlagEvaluationOutcomeCode.MATCH,
      `Matched allocation '${allocation.key}'`,
      flag.variationType,
    )
  }

  logger.debug(`returning default assignment because no allocation matched`, {
    flagKey: flag.key,
    subjectKey,
  })

  return builder.build(defaultValue, FlagEvaluationOutcomeCode.DEFAULT,
    'No allocation matched; returning default value', flag.variationType)
}

function validateTypeMatch(expectedType: FlagValueType, variantType: VariantType): boolean {
  // variantTypeToFlagValueType encodes the full VariantType→FlagValueType mapping; reusing
  // it here keeps the two in sync if new variant types are added later.
  // Unknown variantType values throw from variantTypeToFlagValueType — we let that propagate
  // to evaluate()'s catch block so it is logged at error level as FlagEvaluationOutcomeCode.ERROR,
  // rather than silently surfacing as a TYPE_MISMATCH that implies the caller used the wrong type.
  return variantTypeToFlagValueType(variantType) === expectedType
}

function selectSplitUsingSharding(
  splits: Split[],
  subjectKey: string | null | undefined,
  flagKey: string,
  logger: Logger
): Split | null {
  if (!splits || splits.length === 0) {
    return null
  }

  for (const split of splits) {
    logger.debug(`evaluating split sharding`, {
      flagKey,
      subjectKey,
      variationKey: split.variationKey,
      shards: split.shards,
    })

    // Note: when split.shards is empty, Array.every() returns true vacuously — the split
    // matches without evaluating the subjectKey null guard below. This is pre-existing
    // behavior: an empty shards array acts as a catch-all. A null subjectKey will not
    // throw TargetingKeyMissingError in that case.
    const matches = split.shards.every((shard) => {
      if (subjectKey == null) {
        throw new TargetingKeyMissingError()
      }
      const shardMatches = matchesShard(shard, subjectKey)
      logger.debug(`shard match result`, {
        flagKey,
        subjectKey,
        variationKey: split.variationKey,
        shard: shard,
        matches: shardMatches,
      })
      return shardMatches
    })

    if (matches) {
      logger.debug(`subject matches split`, {
        flagKey,
        subjectKey,
        variationKey: split.variationKey,
      })
      return split
    }
  }

  logger.debug(`subject matches no splits`, {
    flagKey,
    subjectKey,
  })

  return null
}
