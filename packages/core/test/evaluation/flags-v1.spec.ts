import fs from 'node:fs'
import path from 'node:path'
import type { EvaluationContext, FlagValue, JsonValue, Logger, ResolutionDetails } from '@openfeature/core'
import {
  type ExperimentationOptOutOption,
  evaluateRulesBasedConfiguration,
  type UniversalFlagConfigurationV1,
} from '../../src/evaluation'
import type { TestCase } from '../TestCaseResult.types'

describe('Universal Flag Configuration V1', () => {
  let logger: Logger

  const fixtureDirectory = path.join(__dirname, '../ffe-system-test-data')

  beforeEach(() => {
    logger = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: jest.fn(),
    }
  })

  const getUFC = (): UniversalFlagConfigurationV1 => {
    const ufcJson = fs.readFileSync(path.join(fixtureDirectory, 'ufc-config.json'), 'utf8')
    return JSON.parse(ufcJson) as UniversalFlagConfigurationV1
  }

  const getTestCaseFileNames = (): string[] => {
    const fixtureFiles = fs.readdirSync(path.join(fixtureDirectory, 'evaluation-cases')).sort()
    if (fixtureFiles.length === 0) {
      throw new Error('FFE fixture submodule is missing or empty')
    }
    return fixtureFiles
  }

  const getTestCases = (testCaseFileName: string): TestCase[] => {
    const testCases = fs.readFileSync(path.join(fixtureDirectory, 'evaluation-cases', testCaseFileName), 'utf8')
    return JSON.parse(testCases) as TestCase[]
  }

  const evaluateDetails = (
    testCase: TestCase,
    context: EvaluationContext,
    immediate: ExperimentationOptOutOption = false
  ): ResolutionDetails<FlagValue> => {
    const configuration = getUFC()
    if (testCase.variationType === 'BOOLEAN') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        testCase.flag,
        testCase.defaultValue as boolean,
        context,
        logger,
        immediate
      )
    }
    if (testCase.variationType === 'STRING') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'string',
        testCase.flag,
        testCase.defaultValue as string,
        context,
        logger,
        immediate
      )
    }
    if (testCase.variationType === 'INTEGER' || testCase.variationType === 'NUMERIC') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'number',
        testCase.flag,
        testCase.defaultValue as number,
        context,
        logger,
        immediate
      )
    }
    if (testCase.variationType === 'JSON') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'object',
        testCase.flag,
        testCase.defaultValue as JsonValue,
        context,
        logger,
        immediate
      )
    }
    throw new Error(`Unsupported variation type: ${testCase.variationType}`)
  }

  it.each(['constructor', '__proto__'])('treats inherited JSON flag key %s as missing', (flagKey) => {
    expect(evaluateRulesBasedConfiguration(getUFC(), 'boolean', flagKey, false, {}, logger)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    })
  })

  describe.each(getTestCaseFileNames())('should evaluate for %s', (testCaseFileName) => {
    const testCases = getTestCases(testCaseFileName)
    const testCasesWithContext = testCases.map((testCase) => ({
      contextString: JSON.stringify({
        targetingKey: testCase.targetingKey,
        ...testCase.attributes,
      }),
      testCase,
    }))

    it.each(testCasesWithContext)('with context $contextString', ({ contextString, testCase }) => {
      const context = JSON.parse(contextString) as EvaluationContext
      const details = evaluateDetails(testCase, context)
      expect(details.value).toStrictEqual(testCase.result.value)
      expect(details.reason).toEqual(testCase.result.reason)
      if (testCase.result.errorCode !== undefined || testCase.result.reason !== 'ERROR') {
        expect(details.errorCode).toEqual(testCase.result.errorCode)
      }
    })

    for (const [capability, mode] of [
      ['experimentationOptOutImmediate', 'immediate'],
      ['experimentationOptOutFutureExperimentsOnly', 'future_experiments_only'],
    ] as const) {
      for (const testCase of testCases) {
        const expected = testCase.capabilities?.[capability]
        if (!expected) continue
        it(`honors ${mode} opt-out: ${JSON.stringify(testCase.attributes)}`, () => {
          const context = { targetingKey: testCase.targetingKey, ...testCase.attributes } as EvaluationContext
          const details = evaluateDetails(testCase, context, mode)
          expect(details.value).toStrictEqual(expected.value)
          expect(details.reason).toEqual(expected.reason)
          expect(details.errorCode).toEqual(expected.errorCode)
        })
      }
    }
  })
  it('loads the immediate opt-out capability cases', () => {
    const cases = getTestCaseFileNames().flatMap(getTestCases)
    const immediateCases = cases.filter((testCase) => testCase.capabilities?.experimentationOptOutImmediate)
    expect(immediateCases.length).toBe(26)
    expect(cases.filter((testCase) => testCase.capabilities?.experimentationOptOutFutureExperimentsOnly)).toHaveLength(
      42
    )
    expect(new Set(immediateCases.map((testCase) => testCase.variationType))).toEqual(
      new Set(['BOOLEAN', 'STRING', 'INTEGER', 'NUMERIC', 'JSON'])
    )
    expect(
      immediateCases.some((testCase) => testCase.capabilities?.experimentationOptOutImmediate?.reason === 'ERROR')
    ).toBe(true)
    expect(
      immediateCases.some((testCase) => testCase.capabilities?.experimentationOptOutImmediate?.reason === 'DEFAULT')
    ).toBe(true)
    expect(immediateCases.some((testCase) => testCase.targetingKey == null)).toBe(true)
  })
})
