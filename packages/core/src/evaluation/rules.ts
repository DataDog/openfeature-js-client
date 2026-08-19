import type { EvaluationContext, EvaluationContextValue } from '@openfeature/core'
import { coerceToNumber, coerceToString, compileRegex } from './condition-helpers'
import { compareSemver, parseSemver } from './semver'

export type ConditionValueType = EvaluationContextValue | EvaluationContextValue[]

export enum OperatorType {
  MATCHES = 'MATCHES',
  NOT_MATCHES = 'NOT_MATCHES',
  GTE = 'GTE',
  GT = 'GT',
  LTE = 'LTE',
  LT = 'LT',
  ONE_OF = 'ONE_OF',
  NOT_ONE_OF = 'NOT_ONE_OF',
  IS_NULL = 'IS_NULL',
  SEMVER_EQ = 'SEMVER_EQ',
  SEMVER_NEQ = 'SEMVER_NEQ',
  SEMVER_LT = 'SEMVER_LT',
  SEMVER_LTE = 'SEMVER_LTE',
  SEMVER_GT = 'SEMVER_GT',
  SEMVER_GTE = 'SEMVER_GTE',
}

const supportedOperators = new Set<string>(Object.values(OperatorType))

type NumericOperator = OperatorType.GTE | OperatorType.GT | OperatorType.LTE | OperatorType.LT

type MatchesCondition = {
  operator: OperatorType.MATCHES
  attribute: string
  value: string
}

type NotMatchesCondition = {
  operator: OperatorType.NOT_MATCHES
  attribute: string
  value: string
}

type OneOfCondition = {
  operator: OperatorType.ONE_OF
  attribute: string
  value: string[]
}

type NotOneOfCondition = {
  operator: OperatorType.NOT_ONE_OF
  attribute: string
  value: string[]
}

type NumericCondition = {
  operator: NumericOperator
  attribute: string
  value: number
}

type NullCondition = {
  operator: OperatorType.IS_NULL
  attribute: string
  value: boolean
}

type SemverOperator =
  | OperatorType.SEMVER_EQ
  | OperatorType.SEMVER_NEQ
  | OperatorType.SEMVER_LT
  | OperatorType.SEMVER_LTE
  | OperatorType.SEMVER_GT
  | OperatorType.SEMVER_GTE

type SemverCondition = {
  operator: SemverOperator
  attribute: string
  value: string
}

export type Condition =
  | MatchesCondition
  | NotMatchesCondition
  | OneOfCondition
  | NotOneOfCondition
  | NumericCondition
  | NullCondition
  | SemverCondition

export interface Rule {
  conditions: Condition[]
}

export function isValidRule(rule: Rule): boolean {
  if (!Array.isArray(rule.conditions)) {
    return false
  }

  return rule.conditions.every((condition) => {
    if (!supportedOperators.has(condition.operator)) {
      return false
    }
    if (isSemverOperator(condition.operator)) {
      return parseSemver(condition.value) !== null
    }
    if (condition.operator === OperatorType.MATCHES || condition.operator === OperatorType.NOT_MATCHES) {
      try {
        compileRegex(condition.value)
        return true
      } catch {
        return false
      }
    }
    return true
  })
}

export function matchesRule(rule: Rule, subjectAttributes: EvaluationContext): boolean {
  const conditionEvaluations = evaluateRuleConditions(subjectAttributes, rule.conditions)
  // TODO: short-circuit return when false condition is found
  return !conditionEvaluations.includes(false)
}

function evaluateRuleConditions(subjectAttributes: EvaluationContext, conditions: Condition[]): boolean[] {
  return conditions.map((condition) => evaluateCondition(subjectAttributes, condition))
}

function evaluateCondition(subjectAttributes: EvaluationContext, condition: Condition): boolean {
  const value = subjectAttributes[condition.attribute]
  if (condition.operator === OperatorType.IS_NULL) {
    if (condition.value) {
      return value === null || value === undefined
    }
    return value !== null && value !== undefined
  }

  if (value !== null && value !== undefined) {
    switch (condition.operator) {
      case OperatorType.GTE:
      case OperatorType.GT:
      case OperatorType.LTE:
      case OperatorType.LT: {
        const comparator = (a: number, b: number) =>
          condition.operator === OperatorType.GTE
            ? a >= b
            : condition.operator === OperatorType.GT
              ? a > b
              : condition.operator === OperatorType.LTE
                ? a <= b
                : a < b
        return compareNumber(value, condition.value, comparator)
      }
      case OperatorType.MATCHES: {
        const attributeValue = coerceToString(value)
        if (attributeValue === undefined) return false
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return compileRegex(condition.value).test(attributeValue) // dd-iac-scan ignore-line
      }
      case OperatorType.NOT_MATCHES: {
        const attributeValue = coerceToString(value)
        if (attributeValue === undefined) return false
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return !compileRegex(condition.value).test(attributeValue) // dd-iac-scan ignore-line
      }
      case OperatorType.ONE_OF: {
        const attributeValue = coerceToString(value)
        return attributeValue !== undefined && isOneOf(attributeValue, condition.value)
      }
      case OperatorType.NOT_ONE_OF: {
        const attributeValue = coerceToString(value)
        return attributeValue !== undefined && isNotOneOf(attributeValue, condition.value)
      }
      case OperatorType.SEMVER_EQ:
      case OperatorType.SEMVER_NEQ:
      case OperatorType.SEMVER_LT:
      case OperatorType.SEMVER_LTE:
      case OperatorType.SEMVER_GT:
      case OperatorType.SEMVER_GTE:
        return evaluateSemverCondition(value, condition.value, condition.operator)
    }
  }
  return false
}

export function isSemverOperator(operator: string): operator is SemverOperator {
  return (
    operator === OperatorType.SEMVER_EQ ||
    operator === OperatorType.SEMVER_NEQ ||
    operator === OperatorType.SEMVER_LT ||
    operator === OperatorType.SEMVER_LTE ||
    operator === OperatorType.SEMVER_GT ||
    operator === OperatorType.SEMVER_GTE
  )
}

export function hasInvalidSemverComparand(rule: Rule): boolean {
  return rule.conditions.some(
    (condition) => isSemverOperator(condition.operator) && parseSemver(condition.value) === null
  )
}

function evaluateSemverCondition(
  attributeValue: EvaluationContextValue,
  comparandValue: string,
  operator: SemverOperator
): boolean {
  if (typeof attributeValue !== 'string') {
    return false
  }

  const attribute = parseSemver(attributeValue)
  const comparand = parseSemver(comparandValue)
  if (!attribute || !comparand) {
    return false
  }

  const ordering = compareSemver(attribute, comparand)
  switch (operator) {
    case OperatorType.SEMVER_EQ:
      return ordering === 0
    case OperatorType.SEMVER_NEQ:
      return ordering !== 0
    case OperatorType.SEMVER_LT:
      return ordering < 0
    case OperatorType.SEMVER_LTE:
      return ordering <= 0
    case OperatorType.SEMVER_GT:
      return ordering > 0
    case OperatorType.SEMVER_GTE:
      return ordering >= 0
  }
}

function isOneOf(attributeValue: string, conditionValues: string[]) {
  return conditionValues.includes(attributeValue)
}

function isNotOneOf(attributeValue: string, conditionValues: string[]) {
  return !isOneOf(attributeValue, conditionValues)
}

function compareNumber(
  attributeValue: EvaluationContextValue,
  conditionValue: ConditionValueType,
  compareFn: (a: number, b: number) => boolean
): boolean {
  const attribute = coerceToNumber(attributeValue)
  const comparand = coerceToNumber(conditionValue)
  return attribute !== undefined && comparand !== undefined && compareFn(attribute, comparand)
}
