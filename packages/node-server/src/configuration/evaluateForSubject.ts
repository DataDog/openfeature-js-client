import { AttributeType, matchesRule, Rule } from '../rules/rules'
import { matchesShard } from '../shards/matchesShard'
import { Flag, Split } from './ufc-v1'
import { ErrorCode, FlagValueType, Logger, ResolutionDetails, StandardResolutionReasons } from '@openfeature/server-sdk'
import { FlagTypeToValue } from '@datadog/flagging-core'

export function evaluateForSubject<T extends FlagValueType>(
  flag: Flag | undefined,
  type: T,
  subjectKey: string,
  subjectAttributes: Record<string, unknown>,
  defaultValue: FlagTypeToValue<T>,
  logger: Logger
): ResolutionDetails<FlagTypeToValue<T>> {
  if (!flag?.enabled) {
    logger.debug(`returning default assignment because flag is disabled`, {
      flagKey: flag ? flag.key : 'undefined',
      subjectKey,
    })
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.DISABLED,
    }
  }

  const now = new Date()
  for (const allocation of flag.allocations) {
    if (allocation.startAt && now < new Date(allocation.startAt)) {
      logger.debug(`allocation before start date`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
        startAt: allocation.startAt,
      })
      continue
    }

    if (allocation.endAt && now >= new Date(allocation.endAt)) {
      logger.debug(`allocation after end date`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
        endAt: allocation.endAt,
      })
      continue
    }

    const { matched } = containsMatchingRule(allocation.rules, subjectAttributes, logger)
    if (!matched) {
      continue
    }

    const variantValues = Object.values(flag.variations).map((variation) => variation.value);
    const isValid = validateTypeMatch(variantValues, type, flag.variationType)
    if (!isValid) {
      logger.debug(`variant value type mismatch, returning default value`, {
        flagKey: flag.key,
        subjectKey,
        expectedType: type,
        variantType: flag.variationType,
        variantValues: JSON.stringify(variantValues),
      })
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.TYPE_MISMATCH,
      }
    }

    const selectedSplit = selectSplitUsingSharding(allocation.splits, subjectKey, flag.key, logger)
    if (selectedSplit) {
      const variation = flag.variations[selectedSplit.variationKey]
      if (variation) {
        logger.debug(`evaluated a flag`, {
          flagKey: flag.key,
          subjectKey,
          assignment: variation.value,
        })


        return {
          value: variation.value,
          reason: StandardResolutionReasons.TARGETING_MATCH,
        }
      }
    } else {
      logger.debug(`no matching split found for subject`, {
        flagKey: flag.key,
        subjectKey,
        allocationKey: allocation.key,
      })
    }
  }

  logger.debug(`returning default assignment because no allocation matched`, {
    flagKey: flag.key,
    subjectKey,
  })

  return {
    value: defaultValue,
    reason: StandardResolutionReasons.DEFAULT,
  }
}

function validateTypeMatch(
  variantValues: boolean[] | string[] | number[] | object[],
  expectedType: FlagValueType,
  variantType: string
): boolean {
  if (expectedType === 'boolean') {
    return variantType === 'BOOLEAN'
  }
  if (expectedType === 'string') {
    return variantType === 'STRING'
  }
  if (expectedType === 'number') {
    if (variantType === 'INTEGER') {
      return variantValues.every((value) => Number.isInteger(Number(value)))
    }
    if (variantType === 'NUMERIC') {
      return variantValues.every((value) => !isNaN(Number(value)))
    }
    return false
  }
  if (expectedType === 'object') {
    if (variantType === 'JSON') {
      return variantValues.every((value) => typeof value === 'object')
    }
    return false
  }
  throw new Error(`Invalid expected type: ${expectedType}`)
}

export function containsMatchingRule(
  rules: Rule[] | undefined,
  subjectAttributes: Record<string, unknown>,
  logger: Logger
): { matched: boolean; matchedRule: Rule | null } {
  if (!rules?.length) {
    return {
      matched: true,
      matchedRule: null,
    }
  }
  logger.debug(`evaluating rules`, {
    rules: JSON.stringify(rules),
    subjectAttributes,
  })
  const matchedRule = rules.find((rule) => matchesRule(rule, subjectAttributes as Record<string, AttributeType>))
  return !!matchedRule
    ? {
        matched: true,
        matchedRule,
      }
    : {
        matched: false,
        matchedRule: null,
      }
}

function selectSplitUsingSharding(splits: Split[], subjectKey: string, flagKey: string, logger: Logger): Split | null {
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

    // If split has no shards, it matches all subjects
    if (!split.shards || split.shards.length === 0) {
      logger.debug(`split has no shards, matches all subjects`, {
        flagKey,
        subjectKey,
        variationKey: split.variationKey,
      })
      return split
    }

    const matches = split.shards.every((shard) => {
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
