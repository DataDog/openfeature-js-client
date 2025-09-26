import type { EvaluationContext, EvaluationContextValue } from '@openfeature/server-sdk'

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
}

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

export type Condition =
  | MatchesCondition
  | NotMatchesCondition
  | OneOfCondition
  | NotOneOfCondition
  | NumericCondition
  | NullCondition

export interface Rule {
  conditions: Condition[]
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
      case OperatorType.MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return new RegExp(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.NOT_MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return !new RegExp(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.ONE_OF:
        return isOneOf(value.toString(), condition.value)
      case OperatorType.NOT_ONE_OF:
        return isNotOneOf(value.toString(), condition.value)
    }
  }
  return false
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
  return compareFn(Number(attributeValue), Number(conditionValue))
}
