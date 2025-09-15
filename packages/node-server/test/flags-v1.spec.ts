import { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from '../src/configuration/ufc-v1'
import fs from 'fs'
import path from 'path'
import { TestCase } from './TestCaseResult.types'
import { DatadogNodeServerProvider } from '../src/provider'
import type { Logger, EvaluationContext } from '@openfeature/core'
import { OpenFeature } from '@openfeature/server-sdk'

describe('Universal Flag Configuration V1', () => {
  let logger: Logger

  beforeEach(() => {
    logger = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    }
  })

  const getUFC = (): UniversalFlagConfigurationV1 => {
    const ufcJson = fs.readFileSync(path.join(__dirname, '../test/data', 'flags-v1.json'), 'utf8')
    const ufcResponse = JSON.parse(ufcJson) as UniversalFlagConfigurationV1Response
    return ufcResponse.data.attributes
  }

  const getTestCaseFileNames = (): string[] => {
    return fs.readdirSync(path.join(__dirname, '../test/data/tests'))
  }

  const getTestCase = (testCaseFileName: string): TestCase => {
    const testCaseJson = fs.readFileSync(path.join(__dirname, '../test/data/tests', testCaseFileName), 'utf8')
    return JSON.parse(testCaseJson) as TestCase
  }

  const evaluateFlag = async (testCase: TestCase, context: EvaluationContext) => {
    const ufc = getUFC()
    const provider = new DatadogNodeServerProvider({
      configuration: ufc,
    })
    OpenFeature.setProvider(provider)
    OpenFeature.setLogger(logger)
    OpenFeature.setContext(context)
    const client = OpenFeature.getClient()
    if (testCase.variationType === 'BOOLEAN') {
      return await client.getBooleanValue(testCase.flag, testCase.defaultValue as boolean)
    }
    if (testCase.variationType === 'STRING') {
      return await client.getStringValue(testCase.flag, testCase.defaultValue as string)
    }
    if (testCase.variationType === 'INTEGER' || testCase.variationType === 'NUMERIC') {
      return await client.getNumberValue(testCase.flag, testCase.defaultValue as number)
    }
    if (testCase.variationType === 'JSON') {
      return await client.getObjectValue(testCase.flag, testCase.defaultValue as Record<string, any>)
    }
    throw new Error(`Unsupported variation type: ${testCase.variationType}`)
  }

  describe.each(getTestCaseFileNames())('should be able to evaluate the flag for %s', (testCaseFileName) => {
    const testCase = getTestCase(testCaseFileName)
    const subjectKeys = testCase.subjects.map((subject) => subject.subjectKey)
    it.each(subjectKeys)('for subject %s', async (subjectKey) => {
      const subject = testCase.subjects.find((subject) => subject.subjectKey === subjectKey)
      const context: EvaluationContext = {
        targetingKey: subjectKey,
        ...subject?.subjectAttributes,
      }
      if (!subject) {
        throw new Error(`Subject ${subjectKey} not found in test case`)
      }
      const result = await evaluateFlag(testCase, context)
      expect(result).toEqual(subject.assignment)
    })
  })
})
