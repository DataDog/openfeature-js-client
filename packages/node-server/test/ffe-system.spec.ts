import type { Channel } from 'node:diagnostics_channel'
import fs from 'node:fs'
import path from 'node:path'
import type { ExposureEvent } from '@datadog/flagging-core'
import type { EvaluationContext, FlagValue, JsonValue, Logger, ResolutionDetails } from '@openfeature/core'
import type { UniversalFlagConfigurationV1, VariantType } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'

type SystemTestCase = {
  flag: string
  variationType: VariantType
  defaultValue: FlagValue
  targetingKey: string | null
  attributes: Record<string, unknown>
  result: {
    value: FlagValue
    reason: string
  }
}

const fixtureDirectory = path.join(__dirname, '../../core/test/ffe-system-test-data')
const configuration = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, 'ufc-config.json'), 'utf8')
) as UniversalFlagConfigurationV1

const exposureChannel = {
  hasSubscribers: false,
  publish: jest.fn(),
} as unknown as jest.Mocked<Channel<ExposureEvent>>

const logger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}

function getTestCaseFileNames(): string[] {
  const fixtureFiles = fs
    .readdirSync(path.join(fixtureDirectory, 'evaluation-cases'))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
  if (fixtureFiles.length === 0) {
    throw new Error('FFE fixture submodule is missing or empty')
  }
  return fixtureFiles
}

function getTestCases(testCaseFileName: string): SystemTestCase[] {
  return JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, 'evaluation-cases', testCaseFileName), 'utf8')
  ) as SystemTestCase[]
}

async function evaluateTestCase(testCase: SystemTestCase): Promise<ResolutionDetails<FlagValue>> {
  const provider = new DatadogNodeServerProvider({ exposureChannel })
  provider.setConfiguration(configuration)

  const context = {
    ...(testCase.targetingKey === null ? {} : { targetingKey: testCase.targetingKey }),
    ...testCase.attributes,
  } as EvaluationContext

  switch (testCase.variationType) {
    case 'BOOLEAN':
      return provider.resolveBooleanEvaluation(testCase.flag, testCase.defaultValue as boolean, context, logger)
    case 'STRING':
      return provider.resolveStringEvaluation(testCase.flag, testCase.defaultValue as string, context, logger)
    case 'INTEGER':
    case 'NUMERIC':
      return provider.resolveNumberEvaluation(testCase.flag, testCase.defaultValue as number, context, logger)
    case 'JSON':
      return provider.resolveObjectEvaluation(testCase.flag, testCase.defaultValue as JsonValue, context, logger)
  }
}

describe('FFE system tests through DatadogNodeServerProvider', () => {
  describe.each(getTestCaseFileNames())('should evaluate for %s', (testCaseFileName) => {
    const testCases = getTestCases(testCaseFileName)

    it.each(testCases)('with context $targetingKey and flag $flag', async (testCase) => {
      const details = await evaluateTestCase(testCase)

      expect(details.value).toEqual(testCase.result.value)
      expect(details.reason).toEqual(testCase.result.reason)
    })
  })
})
