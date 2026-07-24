import type { EvaluationContext, EvaluationContextValue } from '@openfeature/core'
import { encodeUtf8 } from '../utf8'
import { sha256Hex } from './sha256'

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
  ONE_OF_SHA256 = 'ONE_OF_SHA256',
  NOT_ONE_OF_SHA256 = 'NOT_ONE_OF_SHA256',
  IS_NULL = 'IS_NULL',
  SEMVER_EQUAL = 'SEMVER_EQUAL',
  SEMVER_NOT_EQUAL = 'SEMVER_NOT_EQUAL',
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

type Sha256Condition = {
  operator: OperatorType.ONE_OF_SHA256 | OperatorType.NOT_ONE_OF_SHA256
  attribute: string
  value: {
    salt: number[]
    hashes: string[]
  }
}

type SemverCondition = {
  operator:
    | OperatorType.SEMVER_EQUAL
    | OperatorType.SEMVER_NOT_EQUAL
    | OperatorType.SEMVER_LT
    | OperatorType.SEMVER_LTE
    | OperatorType.SEMVER_GT
    | OperatorType.SEMVER_GTE
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
  | Sha256Condition
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
    if (condition.operator === OperatorType.MATCHES || condition.operator === OperatorType.NOT_MATCHES) {
      try {
        compileRegex(condition.value)
        return true
      } catch {
        return false
      }
    }
    if (condition.operator === OperatorType.ONE_OF_SHA256 || condition.operator === OperatorType.NOT_ONE_OF_SHA256) {
      return (
        Array.isArray(condition.value.salt) &&
        condition.value.salt.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
        condition.value.hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))
      )
    }
    if (condition.operator.startsWith('SEMVER_')) {
      return parseSemver(condition.value as string) !== undefined
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
      case OperatorType.MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return compileRegex(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.NOT_MATCHES:
        // ReDoS mitigation should happen on user input to avoid event loop saturation (https://datadoghq.atlassian.net/browse/FFL-1060)
        return !compileRegex(condition.value).test(String(value)) // dd-iac-scan ignore-line
      case OperatorType.ONE_OF:
        return isOneOf(value.toString(), condition.value)
      case OperatorType.NOT_ONE_OF:
        return isNotOneOf(value.toString(), condition.value)
      case OperatorType.ONE_OF_SHA256:
      case OperatorType.NOT_ONE_OF_SHA256: {
        const encoded = encodeUtf8(String(value))
        const input = new Uint8Array(condition.value.salt.length + encoded.length)
        input.set(condition.value.salt)
        input.set(encoded, condition.value.salt.length)
        const included = condition.value.hashes.includes(sha256Hex(input))
        return condition.operator === OperatorType.ONE_OF_SHA256 ? included : !included
      }
      case OperatorType.SEMVER_EQUAL:
      case OperatorType.SEMVER_NOT_EQUAL:
      case OperatorType.SEMVER_LT:
      case OperatorType.SEMVER_LTE:
      case OperatorType.SEMVER_GT:
      case OperatorType.SEMVER_GTE: {
        const comparison = compareSemver(String(value), condition.value)
        if (comparison === undefined) return false
        if (condition.operator === OperatorType.SEMVER_EQUAL) return comparison === 0
        if (condition.operator === OperatorType.SEMVER_NOT_EQUAL) return comparison !== 0
        if (condition.operator === OperatorType.SEMVER_LT) return comparison < 0
        if (condition.operator === OperatorType.SEMVER_LTE) return comparison <= 0
        if (condition.operator === OperatorType.SEMVER_GT) return comparison > 0
        return comparison >= 0
      }
    }
  }
  return false
}

type Semver = { core: [string, string, string]; prerelease: string[] }

function compareSemver(left: string, right: string): number | undefined {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return undefined
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericIdentifier(a.core[index], b.core[index])
    if (comparison !== 0) return comparison
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1
    }
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/.test(leftIdentifier)
    const rightNumeric = /^\d+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function parseSemver(value: string): Semver | undefined {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  )
  if (!match) return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === '0')) {
    return undefined
  }
  return { core: [match[1], match[2], match[3]], prerelease }
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function compileRegex(pattern: string): RegExp {
  const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/)
  const flags = inlineFlags ? [...new Set(inlineFlags[1])].join('') : ''
  const source = (inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern).split('[:alnum:]').join('A-Za-z0-9')
  return new RegExp(source, flags)
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
