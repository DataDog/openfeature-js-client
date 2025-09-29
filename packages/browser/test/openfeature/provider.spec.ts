import { INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { type EvaluationContext, type Logger, StandardResolutionReasons } from '@openfeature/core'
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../../test/data/precomputed-v1.json'

describe('DatadogProvider', () => {
  let provider: DatadogProvider
  let mockLogger: Logger
  let mockContext: EvaluationContext

  const options: FlaggingInitConfiguration = {
    clientToken: 'xxx',
    applicationId: 'xxx',
    env: 'test',
    site: INTAKE_SITE_STAGING,
  }

  const setupProvider = (): DatadogProvider => {
    provider = new DatadogProvider(options)
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }
    mockContext = {}
    return provider
  }

  describe('configuration validation', () => {
    beforeEach(() => {
      setupProvider()
      OpenFeature.setProvider(provider)
    })

    it('should throw error when ddog-gov.com site is provided', () => {
      const invalidOptions: FlaggingInitConfiguration = {
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: 'ddog-gov.com',
      }

      expect(() => new DatadogProvider(invalidOptions)).toThrow('ddog-gov.com is not supported for flagging endpoints')
    })
  })

  describe('metadata', () => {
    beforeEach(() => {
      setupProvider()
      OpenFeature.setProvider(provider)
    })

    it('should have correct metadata', () => {
      expect(provider.metadata).toEqual({
        name: 'datadog',
      })
    })

    it('should run on client', () => {
      expect(provider.runsOn).toBe('client')
    })
  })

  describe('resolveBooleanEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return default value with DEFAULT reason', () => {
      const result = provider.resolveBooleanEvaluation('test-flag', true, mockContext, mockLogger)
      expect(result).toEqual({
        value: true,
        reason: StandardResolutionReasons.DEFAULT,
      })
    })
  })

  describe('resolveStringEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return default value with DEFAULT reason', () => {
      const result = provider.resolveStringEvaluation('test-flag', 'default', mockContext, mockLogger)
      expect(result).toEqual({
        value: 'default',
        reason: StandardResolutionReasons.DEFAULT,
      })
    })
  })

  describe('resolveNumberEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return default value with DEFAULT reason', () => {
      const result = provider.resolveNumberEvaluation('test-flag', 42, mockContext, mockLogger)
      expect(result).toEqual({
        value: 42,
        reason: StandardResolutionReasons.DEFAULT,
      })
    })
  })

  describe('resolveObjectEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return default value with DEFAULT reason', () => {
      const defaultValue = { key: 'value' }
      const result = provider.resolveObjectEvaluation('test-flag', defaultValue, mockContext, mockLogger)
      expect(result).toEqual({
        value: defaultValue,
        reason: StandardResolutionReasons.DEFAULT,
      })
    })
  })

  describe('onContextChange', () => {
    let originalFetch: (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>
    let fetchMock: jest.Mock

    beforeEach(() => {
      setupProvider()
      fetchMock.mockClear()
    })

    beforeAll(() => {
      // Store the original fetch
      originalFetch = global.fetch

      // Mock the fetch function
      fetchMock = jest.fn().mockImplementation(async (_url, _options) => ({
        ok: true,
        headers: {
          get: jest.fn((name: string) => {
            if (name === 'content-type') return 'application/vnd.api+json'
            return null
          }),
        },
        json: async () => precomputedResponse,
      }))

      global.fetch = fetchMock
    })

    afterAll(() => {
      // Restore the original fetch
      global.fetch = originalFetch
    })

    it('should send expected information in the request', async () => {
      // Set a targeting key in the context
      mockContext = {
        targetingKey: 'test-user',
        customAttribute: 'value',
      }

      await provider.onContextChange({}, mockContext)

      // Check that fetch was called with the correct URL and method
      expect(fetchMock).toHaveBeenCalled()
      const [url, requestOptions] = fetchMock.mock.calls[0]
      expect(url.toString()).toBe(`https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=test`)
      expect(requestOptions.method).toBe('POST')

      // Verify headers were set correctly
      expect(requestOptions.headers).toEqual({
        'Content-Type': 'application/vnd.api+json',
        'dd-client-token': options.clientToken,
        'dd-application-id': options.applicationId,
      })

      // Parse the request body to verify contents are correct
      const requestBody = JSON.parse(requestOptions.body)
      expect(requestBody).toEqual({
        data: {
          type: 'precompute-assignments-request',
          attributes: {
            env: {
              dd_env: options.env,
            },
            sdk: {
              name: 'browser',
              version: '1.0.0-test',
            },
            subject: {
              targeting_key: 'test-user',
              targeting_attributes: {
                targetingKey: 'test-user',
                customAttribute: 'value',
              },
            },
          },
        },
      })

      // Request an evaluation to verify the context updated
      const result = provider.resolveStringEvaluation('string-flag', 'default', mockContext, mockLogger)

      expect(result).toEqual({
        value: 'red',
        variant: 'variation-123',
        reason: 'TARGETING_MATCH',
        flagMetadata: {
          allocationKey: 'allocation-123',
          doLog: true,
          variationType: 'STRING',
        },
      })
    })
  })

  describe('error handling integration', () => {
    let originalFetch: (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>
    let isolatedFetchMock: jest.Mock
    const errorHandler = jest.fn()
    const readyHandler = jest.fn()

    beforeAll(() => {
      originalFetch = global.fetch
    })

    afterAll(() => {
      global.fetch = originalFetch
    })

    beforeEach(async () => {
      isolatedFetchMock = jest.fn()
      global.fetch = isolatedFetchMock
      errorHandler.mockReset()
      readyHandler.mockReset()
      OpenFeature.clearHandlers()
      OpenFeature.addHandler(ProviderEvents.Error, errorHandler)
      OpenFeature.addHandler(ProviderEvents.Ready, readyHandler)
    })

    describe('initialize error handling', () => {
      it('should emit ProviderEvents.Error when fetchFlagsConfiguration fails during initialization', async () => {
        isolatedFetchMock.mockImplementation(async () => ({
          ok: false,
          headers: new Headers({
            'content-type': 'application/vnd.api+json',
          }),
          json: async () => {
            throw new Error('Network error')
          },
        }))
        const testProvider = new DatadogProvider(options)
        await expect(OpenFeature.setProviderAndWait(testProvider)).rejects.toThrow('Network error')
        expect(errorHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            message: 'Network error',
            providerName: 'datadog',
          })
        )
        expect(readyHandler).not.toHaveBeenCalled()
      })

      it('should emit ProviderEvents.Ready when fetchFlagsConfiguration succeeds during initialization', async () => {
        errorHandler.mockReset()
        readyHandler.mockReset()
        isolatedFetchMock.mockImplementation(async () => ({
          ok: true,
          headers: new Headers({
            'content-type': 'application/vnd.api+json',
          }),
          json: async () => precomputedResponse,
        }))
        const testProvider = new DatadogProvider(options)
        await OpenFeature.setProviderAndWait(testProvider)
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(readyHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            providerName: 'datadog',
          })
        )
        expect(errorHandler).not.toHaveBeenCalled()
      })
    })

    describe('onContextChange error handling', () => {
      it('should emit ProviderEvents.Error when fetchFlagsConfiguration fails during context change', async () => {
        errorHandler.mockReset()
        readyHandler.mockReset()

        // First call succeeds for initialization
        isolatedFetchMock.mockImplementationOnce(async () => ({
          ok: true,
          headers: new Headers({
            'content-type': 'application/vnd.api+json',
          }),
          json: async () => precomputedResponse,
        }))

        const testProvider = new DatadogProvider(options)
        await OpenFeature.setProviderAndWait(testProvider)

        errorHandler.mockClear()
        readyHandler.mockClear()

        // Second call fails for context change
        isolatedFetchMock.mockImplementation(() => {
          throw new Error('Context change fetch failed')
        })

        await OpenFeature.setContext({ targetingKey: 'new-user' })

        expect(errorHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({
              message: 'Context change fetch failed',
            }),
            providerName: 'datadog',
          })
        )
      })

      it('should emit ProviderEvents.ContextChanged when fetchFlagsConfiguration succeeds during context change', async () => {
        errorHandler.mockReset()
        readyHandler.mockReset()

        isolatedFetchMock.mockImplementation(async () => ({
          ok: true,
          headers: new Headers({
            'content-type': 'application/vnd.api+json',
          }),
          json: async () => precomputedResponse,
        }))

        const testProvider = new DatadogProvider(options)
        await OpenFeature.setProviderAndWait(testProvider)

        const contextChangedHandler = jest.fn()
        OpenFeature.addHandler(ProviderEvents.ContextChanged, contextChangedHandler)

        await OpenFeature.setContext({ targetingKey: 'new-user' })

        expect(contextChangedHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            providerName: 'datadog',
          })
        )

        OpenFeature.removeHandler(ProviderEvents.ContextChanged, contextChangedHandler)
      })
    })
  })
})
