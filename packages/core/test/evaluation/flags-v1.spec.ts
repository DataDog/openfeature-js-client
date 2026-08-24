import fs from 'node:fs'
import path from 'node:path'
import type { EvaluationContext, FlagValue, JsonValue, Logger, ResolutionDetails } from '@openfeature/core'
import { evaluateRulesBasedConfiguration, type UniversalFlagConfigurationV1 } from '../../src/evaluation'
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

  const evaluateDetails = (testCase: TestCase, context: EvaluationContext): ResolutionDetails<FlagValue> => {
    const configuration = getUFC()
    if (testCase.variationType === 'BOOLEAN') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        testCase.flag,
        testCase.defaultValue as boolean,
        context,
        logger
      )
    }
    if (testCase.variationType === 'STRING') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'string',
        testCase.flag,
        testCase.defaultValue as string,
        context,
        logger
      )
    }
    if (testCase.variationType === 'INTEGER' || testCase.variationType === 'NUMERIC') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'number',
        testCase.flag,
        testCase.defaultValue as number,
        context,
        logger
      )
    }
    if (testCase.variationType === 'JSON') {
      return evaluateRulesBasedConfiguration(
        configuration,
        'object',
        testCase.flag,
        testCase.defaultValue as JsonValue,
        context,
        logger
      )
    }
    throw new Error(`Unsupported variation type: ${testCase.variationType}`)
  }

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
      expect(details.value).toEqual(testCase.result.value)
      expect(details.reason).toEqual(testCase.result.reason)
      if (testCase.result.errorCode !== undefined) {
        expect(details.errorCode).toEqual(testCase.result.errorCode)
      }
    })
  })
})
