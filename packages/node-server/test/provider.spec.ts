import {
  FlagValue,
  HookContext,
  Logger,
  OpenFeature,
  ProviderStatus,
  Hook,
  EvaluationDetails,
  HookHints,
  BaseHook,
} from '@openfeature/server-sdk'
import { DatadogNodeServerProvider } from '../src/provider'
import { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from 'src/configuration/ufc-v1'
import fs from 'fs'
import path from 'path'
import { Channel } from 'diagnostics_channel'
import { ExposureEvent } from '@datadog/flagging-core/src/configuration/exposureEvent.types'

describe('DatadogNodeServerProvider', () => {
  let logger: Logger

  const mockExposureChannel: Channel<ExposureEvent, ExposureEvent> = {
    hasSubscribers: true,
    publish: jest.fn(),
    subscribe: jest.fn(),
  } as unknown as Channel<ExposureEvent, ExposureEvent>

  const configuration = ((): UniversalFlagConfigurationV1 => {
    const ufcJson = fs.readFileSync(path.join(__dirname, './data', 'flags-v1.json'), 'utf8')
    const ufcResponse = JSON.parse(ufcJson) as UniversalFlagConfigurationV1Response
    return ufcResponse.data.attributes
  })()

  beforeEach(() => {
    logger = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: jest.fn(),
    }
  })

  it('should should be ready when configuration is provided', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: configuration,
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('should should be not ready when configuration is not provided', () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
  })

  it('should be ready when configuration is set', () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
    provider.setConfiguration(configuration)
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('should be not ready when configuration is set to undefined', () => {
    const provider = new DatadogNodeServerProvider({
      configuration: configuration,
      exposureChannel: mockExposureChannel,
    })
    expect(provider.status).toBe(ProviderStatus.READY)
    provider.setConfiguration(undefined)
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
  })

  it('should allow hooks to be set', async () => {
    const provider = new DatadogNodeServerProvider({
      configuration: configuration,
      exposureChannel: mockExposureChannel,
    })
    OpenFeature.setProvider(provider)
    OpenFeature.setLogger(logger)
    OpenFeature.setContext({ targetingKey: 'test-user-123' })
    const client = OpenFeature.getClient()
    const afterHook = jest.fn()
    const testHook: BaseHook = {
      after: (
        hookContext: HookContext<FlagValue>,
        evaluationDetails: EvaluationDetails<FlagValue>,
        hookHints?: HookHints
      ) => {
        afterHook(hookContext, evaluationDetails, hookHints)
      },
    }
    client.addHooks(testHook)

    await client.getBooleanDetails('test-flag', false)

    expect(afterHook).toHaveBeenCalled()
  })
})
