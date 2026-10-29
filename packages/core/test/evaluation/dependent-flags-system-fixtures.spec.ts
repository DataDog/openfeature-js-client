import fs from 'node:fs'
import path from 'node:path'
import type { EvaluationContext, FlagValue, JsonValue, Logger, ResolutionDetails } from '@openfeature/core'
import {
  type DependencyEvaluation,
  type DependencyExposureCandidate,
  evaluateRulesBasedConfiguration,
  type UniversalFlagConfigurationV1,
  type VariantType,
} from '../../src/evaluation'

type ExpectedEvent = {
  _count?: number
  flag: string
  allocation?: string
  variant?: string
  errorCode?: string | null
}

type DependentFlagCase = {
  description: string
  attributes: Record<string, unknown>
  defaultValue: FlagValue
  flag: string
  result: { reason: string; value: FlagValue; errorCode?: string }
  targetingKey: string | null
  variationType: VariantType
  expectations?: {
    exposures?: ExpectedEvent[]
    evaluationEvents?: ExpectedEvent[]
    noUnmatchedEvents?: boolean
  }
}

type ActualEvent = {
  flag: string
  allocation?: string
  variant?: string
  errorCode: string | null
}

const fixtureDirectory = path.join(__dirname, '../ffe-system-test-data/evaluation-suites/dependent-flags')
const configuration = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, 'ufc-config.json'), 'utf8')
) as UniversalFlagConfigurationV1
const cases = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, 'cases/dependent-flags.json'), 'utf8')
) as DependentFlagCase[]
const logger: Logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }

describe('dependent-flag shared system fixtures', () => {
  it.each(cases)('$description', (testCase) => {
    const dependencyEvaluations: DependencyEvaluation[] = []
    let dependencyExposures: readonly DependencyExposureCandidate[] = []
    const context: EvaluationContext = {
      ...(testCase.targetingKey === null ? {} : { targetingKey: testCase.targetingKey }),
      ...testCase.attributes,
    }
    const result = evaluate(testCase, context, dependencyEvaluations, (exposures) => {
      dependencyExposures = exposures
    })

    expect(result.value).toStrictEqual(testCase.result.value)
    expect(result.reason).toBe(testCase.result.reason)
    if (testCase.result.errorCode !== undefined || testCase.result.reason !== 'ERROR') {
      expect(result.errorCode).toBe(testCase.result.errorCode)
    }

    if (testCase.expectations?.evaluationEvents) {
      const actual = [
        ...dependencyEvaluations.map(({ flagKey, details }) => evaluationEvent(flagKey, details)),
        evaluationEvent(testCase.flag, result),
      ]
      expectEvents(actual, testCase.expectations.evaluationEvents, testCase.expectations.noUnmatchedEvents)
    }

    if (testCase.expectations?.exposures) {
      const actual = dependencyExposures
        .filter(({ details }) => details.flagMetadata?.__dd_do_log === true)
        .map(({ flagKey, details }) => exposureEvent(flagKey, details))
      if (result.flagMetadata?.__dd_do_log === true && result.reason !== 'ERROR') {
        actual.push(exposureEvent(testCase.flag, result))
      }
      expectEvents(actual, testCase.expectations.exposures, testCase.expectations.noUnmatchedEvents)
    }
  })
})

function evaluate(
  testCase: DependentFlagCase,
  context: EvaluationContext,
  evaluations: DependencyEvaluation[],
  onExposures: (exposures: readonly DependencyExposureCandidate[]) => void
): ResolutionDetails<FlagValue> {
  const onEvaluation = (evaluation: DependencyEvaluation) => evaluations.push(evaluation)
  switch (testCase.variationType) {
    case 'BOOLEAN':
      return evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        testCase.flag,
        testCase.defaultValue as boolean,
        context,
        logger,
        false,
        onEvaluation,
        onExposures
      )
    case 'STRING':
      return evaluateRulesBasedConfiguration(
        configuration,
        'string',
        testCase.flag,
        testCase.defaultValue as string,
        context,
        logger,
        false,
        onEvaluation,
        onExposures
      )
    case 'INTEGER':
    case 'NUMERIC':
      return evaluateRulesBasedConfiguration(
        configuration,
        'number',
        testCase.flag,
        testCase.defaultValue as number,
        context,
        logger,
        false,
        onEvaluation,
        onExposures
      )
    case 'JSON':
      return evaluateRulesBasedConfiguration(
        configuration,
        'object',
        testCase.flag,
        testCase.defaultValue as JsonValue,
        context,
        logger,
        false,
        onEvaluation,
        onExposures
      )
  }
}

function evaluationEvent(flag: string, details: Omit<ResolutionDetails<FlagValue>, 'value'>): ActualEvent {
  return { flag, errorCode: details.errorCode ?? null }
}

function exposureEvent(flag: string, details: Omit<ResolutionDetails<FlagValue>, 'value'>): ActualEvent {
  return {
    flag,
    allocation: details.flagMetadata?.__dd_allocation_key as string | undefined,
    variant: details.variant,
    errorCode: details.errorCode ?? null,
  }
}

function expectEvents(actual: ActualEvent[], expected: ExpectedEvent[], exact = false): void {
  const remaining = [...actual]
  for (const event of expected) {
    const expectedCount = event._count ?? 1
    let matchedCount = 0
    for (let index = 0; index < remaining.length && matchedCount < expectedCount;) {
      const candidate = remaining[index]
      const matches = Object.entries(event).every(
        ([key, value]) => key === '_count' || candidate[key as keyof ActualEvent] === value
      )
      if (matches) {
        remaining.splice(index, 1)
        matchedCount += 1
      } else {
        index += 1
      }
    }
    expect(matchedCount).toBe(expectedCount)
  }
  if (exact) {
    expect(remaining).toHaveLength(0)
  }
}

it('consumes fixture events exclusively in matcher order', () => {
  const actual: ActualEvent[] = [
    { flag: 'shared', errorCode: null },
    { flag: 'unmatched', errorCode: null },
  ]

  expect(() =>
    expectEvents(
      actual,
      [
        { flag: 'shared', _count: 1 },
        { flag: 'shared', errorCode: null, _count: 1 },
      ],
      true
    )
  ).toThrow()
})
