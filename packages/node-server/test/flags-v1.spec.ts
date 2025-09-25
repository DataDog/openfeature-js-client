import type { EvaluationContext, EvaluationDetails, FlagValue, JsonValue, Logger } from '@openfeature/core'
import { OpenFeature } from '@openfeature/server-sdk'
import fs from 'fs'
import { Channel } from 'node:diagnostics_channel'
import path from 'path'
import { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'
import { TestCase } from './TestCaseResult.types'
import { ExposureEvent } from '@datadog/flagging-core'

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
    const testCases = fs.readFileSync(path.join(__dirname, './data/tests', testCaseFileName), 'utf8')
    return JSON.parse(testCases) as TestCase[]
  }

  const evaluateDetails = async (
    testCase: TestCase,
    context: EvaluationContext
  ): Promise<EvaluationDetails<boolean | string | number | JsonValue>> => {
    const ufc = getUFC()
    const provider = new DatadogNodeServerProvider({
      exposureChannel: exposureChannel,
    })
    provider.setConfiguration(ufc)
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
      if (testCase.result.flagMetadata?.doLog) {
        expect(exposureChannelMessageHandler).toHaveBeenCalledWith(
          {
            timestamp: expect.any(Number),
            allocation: {
              key: testCase.result.flagMetadata?.allocationKey,
            },
            flag: {
              key: testCase.flag,
            },
            variant: {
              key: testCase.result.variant,
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
