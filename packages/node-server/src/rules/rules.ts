export type AttributeType = string | number | boolean
export type ConditionValueType = AttributeType | AttributeType[]

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

type SemVerCondition = {
  operator: NumericOperator
  attribute: string
  value: string
}

type StandardNumericCondition = {
  operator: NumericOperator
  attribute: string
  value: number
}

type NumericCondition = StandardNumericCondition

type StandardNullCondition = {
  operator: OperatorType.IS_NULL
  attribute: string
  value: boolean
}

type NullCondition = StandardNullCondition

export type Condition =
  | MatchesCondition
  | NotMatchesCondition
  | OneOfCondition
  | NotOneOfCondition
  | SemVerCondition
  | NumericCondition
  | NullCondition

export interface Rule {
  conditions: Condition[]
}

export function matchesRule(rule: Rule, subjectAttributes: Record<string, AttributeType>): boolean {
  const conditionEvaluations = evaluateRuleConditions(subjectAttributes, rule.conditions)
  // TODO: short-circuit return when false condition is found
  return !conditionEvaluations.includes(false)
}

function evaluateRuleConditions(subjectAttributes: Record<string, any>, conditions: Condition[]): boolean[] {
  return conditions.map((condition) => evaluateCondition(subjectAttributes, condition))
}

function evaluateCondition(subjectAttributes: Record<string, AttributeType>, condition: Condition): boolean {
  const value = subjectAttributes[condition.attribute]
  if (condition.operator === OperatorType.IS_NULL) {
    if (condition.value) {
      return value === null || value === undefined
    }
    return value !== null && value !== undefined
  }

  if (value != null) {
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
        return new RegExp(condition.value as string).test(value as string)
      case OperatorType.NOT_MATCHES:
        return !new RegExp(condition.value as string).test(value as string)
      case OperatorType.ONE_OF:
        return isOneOf(value.toString(), condition.value)
      case OperatorType.NOT_ONE_OF:
        return isNotOneOf(value.toString(), condition.value)
    }
  }
  return false
}

function isOneOf(attributeValue: string, conditionValue: string[]) {
  return getMatchingStringValues(attributeValue, conditionValue).length > 0
}

function isNotOneOf(attributeValue: string, conditionValue: string[]) {
  return getMatchingStringValues(attributeValue, conditionValue).length === 0
}

function getMatchingStringValues(attributeValue: string, conditionValues: string[]): string[] {
  return conditionValues.filter((value) => value === attributeValue)
}

function compareNumber(
  attributeValue: AttributeType,
  conditionValue: ConditionValueType,
  compareFn: (a: number, b: number) => boolean
): boolean {
  return compareFn(Number(attributeValue), Number(conditionValue))
}
