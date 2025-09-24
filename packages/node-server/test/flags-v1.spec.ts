import { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from '../src/configuration/ufc-v1'
import fs from 'fs'
import path from 'path'
import { TestCase } from './TestCaseResult.types'
import { DatadogNodeServerProvider } from '../src/provider'
import type { Logger, EvaluationContext, FlagValue, EvaluationDetails, JsonValue } from '@openfeature/core'
import { OpenFeature } from '@openfeature/server-sdk'
import { Channel, channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent.types'
import { exit } from 'node:process'

type ExposureChannelListener = (message: ExposureEvent, name: string | symbol) => void

describe('Universal Flag Configuration V1', () => {
  let logger: Logger

  const exposureChannelMessageHandler: jest.Mock<ExposureChannelListener> = jest.fn()

  const exposureChannel = {
    hasSubscribers: true,
    publish: jest.fn((message: ExposureEvent) => {
      exposureChannelMessageHandler(message, 'ffe:exposure:submit')
    }),
    subscribe: jest.fn(),
  } as unknown as Channel<ExposureEvent, ExposureEvent>

  beforeEach(() => {
    logger = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: jest.fn(),
    }
    exposureChannelMessageHandler.mockClear()
  })

  const getUFC = (): UniversalFlagConfigurationV1 => {
    const ufcJson = fs.readFileSync(path.join(__dirname, './data', 'flags-v1.json'), 'utf8')
    const ufcResponse = JSON.parse(ufcJson) as UniversalFlagConfigurationV1Response
    return ufcResponse.data.attributes
  }

  const getTestCaseFileNames = (): string[] => {
    return fs.readdirSync(path.join(__dirname, './data/tests'))
  }

  const getTestCases = (testCaseFileName: string): TestCase[] => {
    const testCaseJson = fs.readFileSync(path.join(__dirname, './data/tests', testCaseFileName), 'utf8')
    return JSON.parse(testCaseJson) as TestCase[]
  }

  const evaluateDetails = async (
    testCase: TestCase,
    context: EvaluationContext
  ): Promise<EvaluationDetails<boolean | string | number | JsonValue>> => {
    const ufc = getUFC()
    const provider = new DatadogNodeServerProvider({
      configuration: ufc,
      exposureChannel: exposureChannel,
    })
    OpenFeature.setProvider(provider)
    OpenFeature.setLogger(logger)
    OpenFeature.setContext(context)
    const client = OpenFeature.getClient()
    if (testCase.variationType === 'BOOLEAN') {
      return await client.getBooleanDetails(testCase.flag, testCase.defaultValue as boolean)
    }
    if (testCase.variationType === 'STRING') {
      return await client.getStringDetails(testCase.flag, testCase.defaultValue as string)
    }
    if (testCase.variationType === 'INTEGER' || testCase.variationType === 'NUMERIC') {
      return await client.getNumberDetails(testCase.flag, testCase.defaultValue as number)
    }
    if (testCase.variationType === 'JSON') {
      return await client.getObjectDetails(testCase.flag, testCase.defaultValue as Record<string, FlagValue>)
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

    it.each(testCasesWithContext)('with context $contextString', async ({ contextString, testCase }) => {
      const context = JSON.parse(contextString)
      const details = await evaluateDetails(testCase, context)
      expect(details.value).toEqual(testCase.result.value)
      if (details.flagMetadata?.doLog) {
        expect(exposureChannelMessageHandler).toHaveBeenCalledWith(
          {
            timestamp: expect.any(Number),
            allocation: {
              key: expect.any(String), // TODO evaluation details test cases
            },
            flag: {
              key: testCase.flag,
            },
            variant: {
              key: expect.any(String), // TODO evaluation details test cases
            },
            subject: {
              id: testCase.targetingKey,
              attributes: testCase.attributes,
            },
          },
          'ffe:exposure:submit'
        )
      }
    })
  })
})
