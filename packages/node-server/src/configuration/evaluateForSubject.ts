import { matchesRule, Rule } from '../rules/rules'
import { Attributes } from '../rules/types'
import { matchesShard } from '../shards/matchesShard'
import { Flag, Split } from './ufc-v1'
import { ErrorCode, FlagValueType, Logger, ResolutionDetails } from '@openfeature/server-sdk'
import { VariantValue } from './VariantValue'

export function evaluateForSubject(
  flag: Flag | undefined,
  type: FlagValueType,
  subjectKey: string,
  subjectAttributes: Record<string, any>,
  logger: Logger
): ResolutionDetails<any> | null {
  if (!flag?.enabled) {
    logger.debug(`returning default assignment because flag is disabled`, {
      flagKey: flag ? flag.key : 'undefined',
      subjectKey,
    })
    return {
      value: null,
      reason: 'DISABLED',
    }
  }

  for (const allocation of flag.allocations) {
    const now = new Date()

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

    const selectedSplit = selectSplitUsingSharding(allocation.splits, subjectKey, flag.key, logger)
    if (selectedSplit) {
      const variation = flag.variations[selectedSplit.variationKey]
      if (variation) {
        logger.debug(`evaluated a flag`, {
          flagKey: flag.key,
          subjectKey,
          assignment: variation.value,
        })

        const { value: convertedValue, isValid } = getMatchingValue(variation.value, type, flag.variationType)
        if (!isValid) {
          logger.debug(`variation value type mismatch, returning null`, {
            flagKey: flag.key,
            subjectKey,
            variationKey: selectedSplit.variationKey,
            variationValue: variation.value,
            expectedType: type,
            variantType: flag.variationType,
          })
          return {
            value: null,
            reason: 'ERROR',
            errorCode: 'TYPE_MISMATCH' as ErrorCode,
          }
        }

        return {
          value: convertedValue,
          reason: 'TARGETING_MATCH',
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
    value: null,
    reason: 'DEFAULT',
  }
}

function getMatchingValue(
  value: any,
  expectedType: FlagValueType,
  variantType: string
): { value: any | null; isValid: boolean } {
  const variantValue = new VariantValue(value, variantType)
  if (expectedType === 'boolean') {
    return variantValue.parseBoolean()
  }
  if (expectedType === 'number') {
    return variantValue.parseNumber()
  }
  if (expectedType === 'object') {
    return variantValue.parseObject()
  }
  if (expectedType === 'string') {
    return variantValue.parseString()
  }
  throw new Error(`Invalid expected type: ${expectedType}`)
}

export function containsMatchingRule(
  rules: Rule[] | undefined,
  subjectAttributes: Attributes,
  logger: Logger
): { matched: boolean; matchedRule: Rule | null } {
  if (!rules || !rules.length) {
    return {
      matched: true,
      matchedRule: null,
    }
  }
  let matchedRule: Rule | null = null
  logger.debug(`evaluating rules`, {
    rules: JSON.stringify(rules),
    subjectAttributes,
  })
  const hasMatch = rules.some((rule) => {
    const matched = matchesRule(rule, subjectAttributes)
    if (matched) {
      matchedRule = rule
    }
    return matched
  })
  return hasMatch
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
