import { create } from '@bufbuild/protobuf'
import type { EvaluationContext, FlagValue, Logger, ResolutionDetails } from '@openfeature/core'
import {
  ConditionSchema,
  EvaluatorParamsSchema,
  FlagsConfigurationSchema,
  Reason,
  VariationType,
} from '../../src/configuration/generated/ufc_pb'
import { decodeFlagsConfiguration, encodeFlagsConfiguration } from '../../src/configuration/ufc-protobuf'
import {
  type DependencyEvaluation,
  type DependencyExposureCandidate,
  evaluateRulesBasedConfiguration,
  type Flag,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import { type Condition, OperatorType } from '../../src/evaluation/rules'
import oracleJson from './dependent-flags-lean-oracle.json'

type OracleConditionLeaf =
  | { kind: 'ordinary'; matches: boolean }
  | { kind: 'dependency'; flagKey: string; operator: 'oneOf' | 'notOneOf'; variants: string[] }

type OracleCondition =
  OracleConditionLeaf | { kind: 'all'; children: OracleCondition[] } | { kind: 'any'; children: OracleCondition[] }

type OracleRule = { condition: OracleCondition; variant: string | null }
type OracleBody =
  | { kind: 'rules'; rules: OracleRule[]; fallback: string }
  | { kind: 'disabled' }
  | { kind: 'targetingKeyRequired' }
  | { kind: 'failure'; error: string }
type OracleValueType = 'STRING' | 'BOOLEAN' | 'NUMERIC' | 'JSON'
type OracleFlag = { key: string; valueType: OracleValueType; body: OracleBody }

type OracleExpected = {
  variant: string | null
  error: string | null
  errorMessage: string | null
  usesCallerDefault: boolean
  committedDependencyExposures: Array<{ flagKey: string; variant: string }>
  dependencyEvaluationTelemetry: Array<{
    flagKey: string
    variant: string | null
    error: string | null
    errorMessage: string | null
    reason: string | null
    defaultIdentity: 'emptyString' | 'false' | 'zero' | 'emptyObject' | null
  }>
  memoizedFlags: string[]
  observedExposureKeys: string[]
  observedTelemetryKeys: string[]
}

type OracleCase = {
  name: string
  applicability: 'pr414' | 'jsonOnly' | 'protobufOnly' | 'modelOnly'
  input: { rootKey: string; maxDepth: number; targetingKey: string | null; configuration: OracleFlag[] }
  expected: OracleExpected
}

const oracle = oracleJson as { schemaVersion: number; cases: OracleCase[] }
const ABSENT_ATTRIBUTE = '__lean_absent'

describe.each(['json', 'protobuf'] as const)('Lean dependent-flag conformance: %s UFC', (format) => {
  const logger: Logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
  const applicableCases = oracle.cases.filter(
    ({ applicability }) =>
      applicability === 'pr414' ||
      (format === 'json' && applicability === 'jsonOnly') ||
      (format === 'protobuf' && applicability === 'protobufOnly')
  )

  it.each(applicableCases)('$name', (testCase) => {
    const evaluations: DependencyEvaluation[] = []
    let exposures: readonly DependencyExposureCandidate[] = []
    const configuration = format === 'json' ? buildJsonConfiguration(testCase) : buildProtobufConfiguration(testCase)

    const result = evaluateRulesBasedConfiguration(
      configuration,
      'string',
      testCase.input.rootKey,
      '__caller_default__',
      evaluationContext(testCase.input.targetingKey),
      logger,
      false,
      (evaluation) => evaluations.push(evaluation),
      (committed) => {
        exposures = committed
      }
    )

    const actual = normalizeObservation(testCase.input.rootKey, result, evaluations, exposures)
    expect(actual).toEqual(testCase.expected)
  })
})

describe.each([
  ['json', -1],
  ['json', 256],
  ['json', 1.5],
  ['protobuf', 256],
] as const)('Lean max-depth configuration contract: %s %s', (format, maxDepth) => {
  it('rejects a value outside the inclusive integer range 0 through 255', () => {
    const selectedRule = oracle.cases.find(({ name }) => name === 'selected-rule')
    if (selectedRule === undefined) throw new Error('Lean oracle is missing selected-rule')
    const testCase: OracleCase = { ...selectedRule, input: { ...selectedRule.input, maxDepth } }
    const configuration = format === 'json' ? buildJsonConfiguration(testCase) : buildProtobufConfiguration(testCase)

    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'string',
        testCase.input.rootKey,
        '__caller_default__',
        evaluationContext(testCase.input.targetingKey),
        { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }
      )
    ).toMatchObject({
      value: '__caller_default__',
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'maxDependencyDepth must be an integer from 0 through 255',
    })
  })
})

function buildJsonConfiguration(testCase: OracleCase): UniversalFlagConfigurationV1 {
  const flags = Object.fromEntries(testCase.input.configuration.map((flag) => [flag.key, buildJsonFlag(flag)]))
  return {
    createdAt: '2026-10-27T00:00:00Z',
    format: 'SERVER',
    evaluatorParams: { maxDependencyDepth: testCase.input.maxDepth },
    environment: { name: 'lean-conformance' },
    flags,
  }
}

function buildJsonFlag(flag: OracleFlag): Flag {
  if (flag.body.kind === 'failure') {
    throw new Error(`model-only failure flag ${flag.key} cannot be rendered as a PR 414 vector`)
  }
  if (flag.body.kind === 'disabled') {
    return { key: flag.key, enabled: false, variationType: flag.valueType, variations: {}, allocations: [] }
  }
  if (flag.body.kind === 'targetingKeyRequired') {
    return {
      key: flag.key,
      enabled: true,
      variationType: flag.valueType,
      variations: { required: { key: 'required', value: false } },
      allocations: [
        {
          key: 'targeting-key-required',
          doLog: true,
          rules: [],
          splits: [
            {
              variationKey: 'required',
              shards: [{ salt: 'lean', ranges: [{ start: 0, end: 100 }], totalShards: 100 }],
            },
          ],
        },
      ],
    }
  }
  const variantKeys = unique([
    flag.body.fallback,
    ...flag.body.rules.flatMap(({ variant }) => (variant === null ? [] : [variant])),
  ])
  return {
    key: flag.key,
    enabled: true,
    variationType: flag.valueType,
    variations: Object.fromEntries(variantKeys.map((key, index) => [key, { key, value: jsonValue(flag, key, index) }])),
    allocations: [
      ...flag.body.rules.map((rule, index) => ({
        key: `rule-${index}`,
        doLog: true,
        rules: [{ conditions: jsonConditions(rule.condition) }],
        splits: rule.variant === null ? [] : [{ variationKey: rule.variant, shards: [] }],
      })),
      {
        key: 'fallback',
        doLog: true,
        rules: [],
        splits: [{ variationKey: flag.body.fallback, shards: [] }],
      },
    ],
  }
}

function jsonConditions(expression: OracleCondition): Condition[] {
  if (expression.kind !== 'all') {
    throw new Error(`JSON UFC cannot render Lean ${expression.kind} expression`)
  }
  return expression.children.map((condition) => {
    if (condition.kind === 'all' || condition.kind === 'any') {
      throw new Error(`JSON UFC cannot render nested Lean ${condition.kind} expression`)
    }
    return jsonCondition(condition)
  })
}

function jsonCondition(condition: OracleConditionLeaf): Condition {
  if (condition.kind === 'ordinary') {
    return { attribute: ABSENT_ATTRIBUTE, operator: OperatorType.IS_NULL, value: condition.matches }
  }
  return {
    flagEvaluation: { key: condition.flagKey },
    operator: condition.operator === 'oneOf' ? OperatorType.ONE_OF : OperatorType.NOT_ONE_OF,
    value: condition.variants,
  }
}

function buildProtobufConfiguration(testCase: OracleCase) {
  const interned = new StringInterner()
  const absentStringIndex = interned.index(ABSENT_ATTRIBUTE)
  const conditions: ReturnType<typeof protobufCondition>[] = []
  const flags = Object.fromEntries(
    testCase.input.configuration.map((flag) => {
      if (flag.body.kind === 'targetingKeyRequired') {
        return [
          flag.key,
          {
            variationType: protobufVariationType(flag.valueType),
            variations: [
              {
                keyStringIndex: interned.index('required'),
                value: protobufVariationValue(flag.valueType, 'required', 0, interned),
              },
            ],
            allocations: [
              {
                key: 'targeting-key-required',
                partitionKey: [
                  {
                    kind: {
                      case: 'shardMd5' as const,
                      value: { salt: 'lean', attributeIndex: 1, totalShards: BigInt(100) },
                    },
                  },
                ],
                splits: [
                  {
                    ranges: [{ from: BigInt(0), to: BigInt(100) }],
                    variationIndex: 0,
                    serialId: 1,
                    reason: Reason.SPLIT,
                  },
                ],
                logExposureEvent: true,
              },
            ],
          },
        ]
      }
      if (flag.body.kind !== 'rules') {
        throw new Error(`${flag.body.kind} flag ${flag.key} cannot be rendered as a protobuf vector`)
      }
      const variantKeys = unique([
        flag.body.fallback,
        ...flag.body.rules.flatMap(({ variant }) => (variant === null ? [] : [variant])),
      ])
      const variationIndex = new Map(variantKeys.map((key, index) => [key, index]))
      const allocations = flag.body.rules.map((rule, index) => {
        const targetingConditionIndex = appendProtobufExpression(rule.condition, conditions, interned)
        return {
          key: `rule-${index}`,
          targetingConditionIndex,
          partitionKey: [],
          splits:
            rule.variant === null
              ? []
              : [
                  {
                    ranges: [],
                    variationIndex: variationIndex.get(rule.variant) as number,
                    serialId: index + 1,
                    reason: Reason.TARGETING_MATCH,
                  },
                ],
          logExposureEvent: true,
        }
      })
      const fallbackConditionIndex = conditions.length
      conditions.push(create(ConditionSchema, { kind: { case: 'all', value: { conditionIndexes: [] } } }))
      allocations.push({
        key: 'fallback',
        targetingConditionIndex: fallbackConditionIndex,
        partitionKey: [],
        splits: [
          {
            ranges: [],
            variationIndex: variationIndex.get(flag.body.fallback) as number,
            serialId: allocations.length + 1,
            reason: Reason.STATIC,
          },
        ],
        logExposureEvent: true,
      })
      return [
        flag.key,
        {
          variationType: protobufVariationType(flag.valueType),
          variations: variantKeys.map((key, index) => ({
            keyStringIndex: interned.index(key),
            value: protobufVariationValue(flag.valueType, key, index, interned),
          })),
          allocations,
        },
      ]
    })
  )
  const configuration = create(FlagsConfigurationSchema, {
    environmentName: 'lean-conformance',
    evaluatorParams: create(EvaluatorParamsSchema, { maxDependencyDepth: BigInt(testCase.input.maxDepth) }),
    attributes: [
      {
        kind: {
          case: 'attributePath',
          value: { segments: [{ kind: { case: 'objectKeyStringIndex', value: absentStringIndex } }] },
        },
      },
      { kind: { case: 'targetingKey', value: {} } },
    ],
    strings: interned.values,
    conditions,
    flags,
  })
  return decodeFlagsConfiguration(encodeFlagsConfiguration(configuration))
}

function appendProtobufExpression(
  expression: OracleCondition,
  conditions: ReturnType<typeof protobufCondition>[],
  interned: StringInterner
): number {
  if (expression.kind === 'ordinary' || expression.kind === 'dependency') {
    const index = conditions.length
    conditions.push(protobufCondition(expression, interned))
    return index
  }
  const childIndexes = expression.children.map((child) => appendProtobufExpression(child, conditions, interned))
  const index = conditions.length
  conditions.push(
    create(ConditionSchema, { kind: { case: expression.kind, value: { conditionIndexes: childIndexes } } })
  )
  return index
}

function protobufCondition(condition: OracleConditionLeaf, interned: StringInterner) {
  if (condition.kind === 'ordinary') {
    return create(ConditionSchema, {
      kind: { case: 'attributePresence', value: { attributeIndex: 0, expectNull: condition.matches } },
    })
  }
  return create(ConditionSchema, {
    kind: {
      case: 'flagEvaluationStringMembership',
      value: {
        flagKeyStringIndex: interned.index(condition.flagKey),
        variantKeyStringIndexes: condition.variants.map((variant) => interned.index(variant)),
        negate: condition.operator === 'notOneOf',
      },
    },
  })
}

function normalizeObservation(
  rootKey: string,
  result: ResolutionDetails<string>,
  evaluations: readonly DependencyEvaluation[],
  exposures: readonly DependencyExposureCandidate[]
): OracleExpected {
  const dependencyEvaluationTelemetry = evaluations.map(({ flagKey, details }) => ({
    flagKey,
    variant: details.variant ?? null,
    error: details.errorCode ?? null,
    errorMessage: details.errorMessage ?? null,
    reason: details.errorCode === undefined ? null : (details.reason ?? null),
    defaultIdentity: details.errorCode === undefined ? null : defaultIdentity(details.value),
  }))
  const committedDependencyExposures = exposures.map(({ flagKey, details }) => ({
    flagKey,
    variant: details.variant as string,
  }))
  const rootSucceeded = result.variant !== undefined && result.errorCode === undefined
  return {
    variant: result.variant ?? null,
    error: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    usesCallerDefault: result.errorCode !== undefined && result.value === '__caller_default__',
    committedDependencyExposures,
    dependencyEvaluationTelemetry,
    memoizedFlags: dependencyEvaluationTelemetry
      .filter(({ variant, error }) => variant !== null && error === null)
      .map(({ flagKey }) => flagKey),
    observedExposureKeys: [
      ...committedDependencyExposures.map(({ flagKey }) => flagKey),
      ...(rootSucceeded ? [rootKey] : []),
    ],
    observedTelemetryKeys: [...dependencyEvaluationTelemetry.map(({ flagKey }) => flagKey), rootKey],
  }
}

function jsonValue(flag: OracleFlag, key: string, index: number): FlagValue {
  switch (flag.valueType) {
    case 'STRING':
      return key
    case 'BOOLEAN':
      return index % 2 === 0
    case 'NUMERIC':
      return index
    case 'JSON':
      return { key }
  }
}

function protobufVariationType(valueType: OracleValueType): VariationType {
  switch (valueType) {
    case 'STRING':
      return VariationType.STRING
    case 'BOOLEAN':
      return VariationType.BOOLEAN
    case 'NUMERIC':
      return VariationType.NUMERIC
    case 'JSON':
      return VariationType.JSON
  }
}

function protobufVariationValue(valueType: OracleValueType, key: string, index: number, interned: StringInterner) {
  switch (valueType) {
    case 'STRING':
      return { case: 'stringValueIndex' as const, value: interned.index(key) }
    case 'BOOLEAN':
      return { case: 'booleanValue' as const, value: index % 2 === 0 }
    case 'NUMERIC':
      return { case: 'numericValue' as const, value: index }
    case 'JSON':
      return { case: 'jsonStringIndex' as const, value: interned.index(JSON.stringify({ key })) }
  }
}

function defaultIdentity(
  value: FlagValue | undefined
): OracleExpected['dependencyEvaluationTelemetry'][number]['defaultIdentity'] {
  if (value === '') return 'emptyString'
  if (value === false) return 'false'
  if (value === 0) return 'zero'
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
    return 'emptyObject'
  }
  return null
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function evaluationContext(targetingKey: string | null): EvaluationContext {
  return targetingKey === null ? {} : { targetingKey }
}

class StringInterner {
  readonly values: string[] = []
  private readonly indexes = new Map<string, number>()

  index(value: string): number {
    const existing = this.indexes.get(value)
    if (existing !== undefined) return existing
    const index = this.values.length
    this.values.push(value)
    this.indexes.set(value, index)
    return index
  }
}
