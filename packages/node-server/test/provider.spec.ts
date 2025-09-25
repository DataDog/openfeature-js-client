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
  ProviderEvents,
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
  it('should allow hooks to be set', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait(provider)
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
  }, 1000)

  it('should only emit ready event after configuration is set', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Ready, () => {
      eventHandler()
    })
    expect(eventHandler).not.toHaveBeenCalled()
    provider.setConfiguration(configuration)
    await promise
    expect(eventHandler).toHaveBeenCalled()
  }, 1000)

  it('should allow configuration to be set before initialization', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Ready, () => {
      eventHandler()
    })
    expect(eventHandler).toHaveBeenCalled()
  }, 1000)

  it('should emit error event if an error was encountered on initialization', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Error, () => {
      eventHandler()
    })
    provider.setError(new Error('test error'))
    expect.assertions(1)
    return promise.catch(() => {
      expect(eventHandler).toHaveBeenCalled()
    })
  }, 1000)

  it('should emit error event if an error was encountered after initialization', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    provider.setConfiguration(configuration)
    await promise

    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Error, () => {
      eventHandler()
    })
    expect(eventHandler).not.toHaveBeenCalled()
    provider.setError(new Error('test error'))
    expect(eventHandler).toHaveBeenCalled()
  }, 1000)

  it('should emit configuration changed event after configuration is set', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    provider.setConfiguration(configuration)
    await promise
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.ConfigurationChanged, () => {
      eventHandler()
    })
    expect(eventHandler).not.toHaveBeenCalled()
    provider.setConfiguration({ ...configuration })
    expect(eventHandler).toHaveBeenCalled()
  }, 1000)
})
