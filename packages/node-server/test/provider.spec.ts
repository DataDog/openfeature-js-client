import type { Channel } from 'node:diagnostics_channel'
import fs from 'node:fs'
import path from 'node:path'
import type { ExposureEvent } from '@datadog/flagging-core'
import {
  type BaseHook,
  type EvaluationDetails,
  type FlagValue,
  type HookContext,
  type HookHints,
  type Logger,
  OpenFeature,
  ProviderEvents,
} from '@openfeature/server-sdk'
import type { UniversalFlagConfigurationV1, UniversalFlagConfigurationV1Response } from 'src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'

describe('DatadogNodeServerProvider', () => {
  let logger: Logger

  const mockExposureChannel = {
    hasSubscribers: true,
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    bindStore: jest.fn(),
    unbindStore: jest.fn(),
    runStores: jest.fn(),
    name: 'ffe:exposure:submit',
  } as jest.Mocked<Channel<ExposureEvent, ExposureEvent>>

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

  function getConfigurationWithDoLogEnabledOrDisabled(
    configuration: UniversalFlagConfigurationV1,
    flagKey: string,
    doLog: boolean
  ): UniversalFlagConfigurationV1 {
    return {
      ...configuration,
      flags: {
        ...configuration.flags,
        [flagKey]: {
          ...configuration.flags[flagKey],
          allocations: [
            ...configuration.flags[flagKey].allocations.map((allocation) => {
              allocation.doLog = doLog
              return allocation
            }),
          ],
        },
      },
    }
  }

  function enableDoLogForFlags(
    configuration: UniversalFlagConfigurationV1,
    flagKeys: string[]
  ): UniversalFlagConfigurationV1 {
    let modifiedConfiguration = { ...configuration }
    for (const flagKey of flagKeys) {
      modifiedConfiguration = getConfigurationWithDoLogEnabledOrDisabled(modifiedConfiguration, flagKey, true)
    }
    return modifiedConfiguration
  }

  function disableDoLogForFlags(
    configuration: UniversalFlagConfigurationV1,
    flagKeys: string[]
  ): UniversalFlagConfigurationV1 {
    let modifiedConfiguration = { ...configuration }
    for (const flagKey of flagKeys) {
      modifiedConfiguration = getConfigurationWithDoLogEnabledOrDisabled(modifiedConfiguration, flagKey, false)
    }
    return modifiedConfiguration
  }

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

  it('should timeout if configuration is not set within 30 seconds (default)', async () => {
    jest.useFakeTimers()
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Error, () => {
      eventHandler()
    })

    // Fast-forward time by 30 seconds
    jest.advanceTimersByTime(30000)

    expect.assertions(2)
    return promise
      .catch((error) => {
        expect(error.message).toContain('Initialization timeout after 30000ms')
        expect(eventHandler).toHaveBeenCalled()
      })
      .finally(() => {
        jest.useRealTimers()
      })
  }, 1000)

  it('should timeout with custom timeout value', async () => {
    jest.useFakeTimers()
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
      initializationTimeoutMs: 5000,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    const eventHandler = jest.fn()
    client.addHandler(ProviderEvents.Error, () => {
      eventHandler()
    })

    // Fast-forward time by 5 seconds
    jest.advanceTimersByTime(5000)

    expect.assertions(2)
    return promise
      .catch((error) => {
        expect(error.message).toContain('Initialization timeout after 5000ms')
        expect(eventHandler).toHaveBeenCalled()
      })
      .finally(() => {
        jest.useRealTimers()
      })
  }, 1000)

  it('should emit ready event when config is set after timeout (recovery from error)', async () => {
    jest.useFakeTimers()
    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
      initializationTimeoutMs: 5000,
    })
    const promise = OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()

    const errorHandler = jest.fn()
    const readyHandler = jest.fn()

    client.addHandler(ProviderEvents.Error, () => {
      errorHandler()
    })
    client.addHandler(ProviderEvents.Ready, () => {
      readyHandler()
    })

    // Fast-forward time by 5 seconds to trigger timeout
    jest.advanceTimersByTime(5000)

    await promise.catch(() => {
      // Initialization failed due to timeout
      expect(errorHandler).toHaveBeenCalledTimes(1)
    })

    // Now set configuration after timeout - should emit PROVIDER_READY to signal recovery
    provider.setConfiguration(configuration)

    // Should emit Ready event (recovery from error state)
    expect(readyHandler).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  }, 1000)

  it('should log timeout error with custom logger when provided', async () => {
    jest.useFakeTimers()
    const mockLogger = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    }

    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
      initializationTimeoutMs: 5000,
      logger: mockLogger,
    })

    const promise = OpenFeature.setProviderAndWait(provider)

    // Fast-forward time by 5 seconds to trigger timeout
    jest.advanceTimersByTime(5000)

    await promise.catch(() => {
      // Expected to fail
    })

    // Verify logger.error was called with the timeout message
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Provider initialization timeout after %dms',
      5000,
      expect.objectContaining({
        message: 'Initialization timeout after 5000ms',
      })
    )

    jest.useRealTimers()
  }, 1000)

  it('should log timeout error to console when no logger provided', async () => {
    jest.useFakeTimers()
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

    const provider = new DatadogNodeServerProvider({
      exposureChannel: mockExposureChannel,
      initializationTimeoutMs: 5000,
    })

    const promise = OpenFeature.setProviderAndWait(provider)

    // Fast-forward time by 5 seconds to trigger timeout
    jest.advanceTimersByTime(5000)

    await promise.catch(() => {
      // Expected to fail
    })

    // Verify console.error was called
    expect(consoleSpy).toHaveBeenCalledWith(
      'Provider initialization timeout after %dms',
      5000,
      expect.objectContaining({
        message: 'Initialization timeout after 5000ms',
      })
    )

    consoleSpy.mockRestore()
    jest.useRealTimers()
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
    expect(eventHandler).toHaveBeenCalledTimes(1)
  }, 1000)

  describe('Exposures end-to-end', () => {
    beforeEach(() => {
      // clear publish mock
      mockExposureChannel.publish.mockClear()
    })
    it('should send exposure events when exposure logging is enabled', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      provider.setConfiguration(configuration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123' })
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
    })

    it('should should not send duplicate exposure events', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      provider.setConfiguration(configuration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123' })
      await client.getBooleanDetails('kill-switch', false)
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
    })

    it('should should send duplicate exposure events when context changes', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      provider.setConfiguration(configuration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123' })
      await client.getBooleanDetails('kill-switch', false)
      OpenFeature.setContext({ targetingKey: 'test-user-321' })
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(2)
    })

    it('logs for each unique flag', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      const modifiedConfiguration = enableDoLogForFlags(configuration, [
        'kill-switch',
        'new-user-onboarding',
        'integer-flag',
      ])
      provider.setConfiguration(modifiedConfiguration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123', id: 'zach' })
      await client.getBooleanDetails('kill-switch', false)
      await client.getBooleanDetails('kill-switch', false)
      await client.getStringDetails('new-user-onboarding', 'control')
      await client.getStringDetails('new-user-onboarding', 'control')
      await client.getNumberValue('integer-flag', 1)
      await client.getNumberValue('integer-flag', 1)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(3)
    })

    it('should not send exposure events when doLog is false', async () => {
      const modifiedConfiguration = disableDoLogForFlags(configuration, ['kill-switch'])
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      provider.setConfiguration(modifiedConfiguration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123' })
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).not.toHaveBeenCalled()
    })

    it('should clear exposure cache when configuration createdAt changes', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      const modifiedConfiguration = enableDoLogForFlags(configuration, ['kill-switch'])
      provider.setConfiguration(modifiedConfiguration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123', country: 'US' })

      // First evaluation - should log exposure
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

      // Second evaluation - should not log (cached)
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

      // Update configuration with new createdAt
      const updatedConfiguration = {
        ...modifiedConfiguration,
        createdAt: new Date().toISOString(),
      }
      provider.setConfiguration(updatedConfiguration)

      // Third evaluation - should log again because cache was cleared
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(2)
    })

    it('should not clear exposure cache when configuration createdAt stays the same', async () => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: mockExposureChannel,
      })
      const modifiedConfiguration = enableDoLogForFlags(configuration, ['kill-switch'])
      provider.setConfiguration(modifiedConfiguration)
      await OpenFeature.setProviderAndWait(provider)
      const client = OpenFeature.getClient()
      OpenFeature.setContext({ targetingKey: 'test-user-123', country: 'US' })

      // First evaluation - should log exposure
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

      // Update configuration with same createdAt
      const updatedConfiguration = {
        ...modifiedConfiguration,
        flags: {
          ...modifiedConfiguration.flags,
          // Change something but keep createdAt the same
        },
      }
      provider.setConfiguration(updatedConfiguration)

      // Second evaluation - should not log (cache not cleared)
      await client.getBooleanDetails('kill-switch', false)
      expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
    })
  })
})
