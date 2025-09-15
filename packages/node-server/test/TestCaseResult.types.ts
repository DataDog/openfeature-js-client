import { VariantType } from 'src/configuration/ufc-v1'

/**
 * Types generated from test-case files in test/data/tests folder
 */

export type FlagEvaluationCode =
  | 'MATCH'
  | 'ASSIGNMENT_ERROR'
  | 'DEFAULT_ALLOCATION_NULL'
  | 'FLAG_UNRECOGNIZED_OR_DISABLED'
  | 'TYPE_MISMATCH'
  | 'TARGETING_MATCH'
  | 'DISABLED'
  | 'ERROR'

export type AllocationEvaluationCode =
  | 'MATCH'
  | 'AFTER_END_TIME'
  | 'BEFORE_START_TIME'
  | 'FAILING_RULE'
  | 'TRAFFIC_EXPOSURE_MISS'
  | 'UNEVALUATED'

export type ConditionOperator =
  | 'GT'
  | 'GTE'
  | 'IS_NULL'
  | 'LT'
  | 'LTE'
  | 'MATCHES'
  | 'NOT_MATCHES'
  | 'NOT_ONE_OF'
  | 'ONE_OF'

export interface Condition {
  attribute: string
  operator: ConditionOperator
  value: string | string[]
}

export interface MatchedRule {
  conditions: Condition[]
}

export interface AllocationResult {
  key: string
  allocationEvaluationCode: AllocationEvaluationCode
  orderPosition: number
}

export interface MatchedAllocation extends AllocationResult {
  allocationEvaluationCode: 'MATCH'
}

export interface EvaluationDetails {
  environmentName: string
  flagEvaluationCode: FlagEvaluationCode
  flagEvaluationDescription: string
  banditKey: string | null
  banditAction: string | null
  variationKey: string | null
  variationValue: number | null
  matchedRule: MatchedRule | null
  matchedAllocation: MatchedAllocation | null
  unmatchedAllocations: AllocationResult[]
  unevaluatedAllocations: AllocationResult[]
}

export interface Subject {
  subjectKey: string
  subjectAttributes: object
  assignment: number
  evaluationDetails: EvaluationDetails
}

export interface TestCase {
  flag: string
  variationType: VariantType
  defaultValue: number | string | boolean | object
  subjects: Subject[]
}
