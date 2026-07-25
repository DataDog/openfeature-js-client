import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { type EvaluationContext, type Logger, StandardResolutionReasons } from '@openfeature/core'
import { OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
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

  describe('hooks configuration', () => {
    it('should add exposure logging hook by default when enableExposureLogging is not specified', () => {
      const providerWithDefaults = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        // enableExposureLogging not specified - should default to true
      })
      // Should have 3 hooks: EVP flag evaluation (default true) + exposure logging (default true) + auto RUM tracking
      expect(providerWithDefaults.hooks).toHaveLength(3)
    })

    it('should not add exposure logging hook when enableExposureLogging is false', () => {
      const providerWithoutExposures = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
      })
      // Should have 2 hooks: EVP flag evaluation + auto RUM tracking
      expect(providerWithoutExposures.hooks).toHaveLength(2)
    })

    it('should add EVP flag evaluation hook by default when enableFlagEvaluationTracking is not specified', () => {
      const providerWithDefaults = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        // enableFlagEvaluationTracking not specified - should default to true
      })
      // Should have 3 hooks: EVP flag evaluation (default true) + exposure logging (default true) + auto RUM tracking
      expect(providerWithDefaults.hooks).toHaveLength(3)
    })

    it('should not add EVP flag evaluation hook when enableFlagEvaluationTracking is false', () => {
      const providerWithoutEvalTracking = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableFlagEvaluationTracking: false,
      })
      // Should have 2 hooks: exposure logging + auto RUM tracking
      expect(providerWithoutEvalTracking.hooks).toHaveLength(2)
    })

    it('should have auto RUM tracking hook even when both other tracking options are disabled', () => {
      const providerWithMinHooks = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
      })
      // Should have 1 hook: auto RUM tracking only
      expect(providerWithMinHooks.hooks).toHaveLength(1)
    })

    it('should not add auto RUM tracking hook when enableRumFeatureFlagTracking is false', () => {
      const providerWithoutRum = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableRumFeatureFlagTracking: false,
      })
      // Should have 2 hooks: EVP flag evaluation + exposure logging
      expect(providerWithoutRum.hooks).toHaveLength(2)
    })

    it('should have no hooks when all tracking options are disabled', () => {
      const providerWithNoHooks = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      })
      expect(providerWithNoHooks.hooks).toHaveLength(0)
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
            source: {
              sdk_name: 'browser',
              sdk_version: '1.0.0-test',
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

    it('should include RUM user properties in the configuration request', async () => {
      const globalObject = getGlobalObject<{ DD_RUM?: DDRum }>()
      globalObject.DD_RUM = {
        addFeatureFlagEvaluation: jest.fn(),
        getUser: () => ({
          id: 'rum-user',
          user_email: 'rum@example.com',
          company_name: 'Example, Inc.',
          profile: { plan: 'enterprise' },
        }),
      }

      try {
        await provider.onContextChange({}, { user_email: 'explicit@example.com' })

        const [, requestOptions] = fetchMock.mock.calls[0]
        const requestBody = JSON.parse(requestOptions.body)
        expect(requestBody.data.attributes.subject).toEqual({
          targeting_key: 'rum-user',
          targeting_attributes: {
            targetingKey: 'rum-user',
            user_email: 'explicit@example.com',
            company_name: 'Example, Inc.',
          },
        })
      } finally {
        delete globalObject.DD_RUM
      }
    })
  })

  describe('concurrent request ordering', () => {
    let originalFetch: (input: RequestInfo | URL, init?: RequestInit | undefined) => Promise<Response>

    beforeAll(() => {
      originalFetch = global.fetch
    })

    afterAll(() => {
      global.fetch = originalFetch
    })

    const makeResponse = (stringFlagValue: string) => ({
      data: {
        id: 'test_subject',
        type: 'precomputed-assignments',
        attributes: {
          createdAt: Date.now(),
          environment: { name: 'prod' },
          flags: {
            'string-flag': {
              allocationKey: 'allocation-123',
              variationKey: 'variation-123',
              variationType: 'STRING',
              variationValue: stringFlagValue,
              extraLogging: { experiment: 'true' },
              doLog: true,
              reason: 'TARGETING_MATCH',
            },
          },
        },
      },
    })

    const makeFetchResponse = (body: ReturnType<typeof makeResponse>) => ({
      ok: true,
      headers: {
        get: (name: string) => (name === 'content-type' ? 'application/vnd.api+json' : null),
      },
      json: async () => body,
    })

    /** Installs a fetch mock where each call creates a deferred promise accessible via `calls[n]`. */
    function mockFetchDeferred() {
      const calls: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
      const mock = jest.fn().mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            calls.push({ resolve, reject })
          })
      )
      global.fetch = mock
      return { mock, calls }
    }

    it('last onContextChange call wins even if earlier call resolves later', async () => {
      const provider = new DatadogProvider(options)
      const { calls } = mockFetchDeferred()

      // Fire both concurrently
      const first = provider.onContextChange({}, { targetingKey: 'user-1' })
      const second = provider.onContextChange({}, { targetingKey: 'user-2' })

      // Resolve second first, then first
      calls[1].resolve(makeFetchResponse(makeResponse('second')))
      calls[0].resolve(makeFetchResponse(makeResponse('first')))

      // With chaining, both settle together
      await Promise.all([first, second])

      // The second call (last called) should win
      const result = provider.resolveStringEvaluation(
        'string-flag',
        'default',
        {},
        { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      )
      expect(result.value).toBe('second')
    })

    it('stays in RECONCILING when stale request resolves but latest is still pending', async () => {
      const provider = new DatadogProvider(options)
      const { calls } = mockFetchDeferred()

      // Initialize first so provider is in READY state
      const init = provider.initialize({})
      calls[0].resolve(makeFetchResponse(makeResponse('init')))
      await init

      const first = provider.onContextChange({}, { targetingKey: 'user-1' })
      const second = provider.onContextChange({}, { targetingKey: 'user-2' })

      // Resolve only the stale request — first chains to second, so it won't settle yet
      calls[1].resolve(makeFetchResponse(makeResponse('first')))
      // Flush microtask to let the stale check run
      await Promise.resolve()

      // Status should still be RECONCILING because the latest (second) request is pending
      expect(provider.status).toBe(ProviderStatus.RECONCILING)

      // Now resolve the latest — both settle
      calls[2].resolve(makeFetchResponse(makeResponse('second')))
      await Promise.all([first, second])
      expect(provider.status).toBe(ProviderStatus.READY)
    })

    it('ignores error from stale request when a newer request is pending', async () => {
      const provider = new DatadogProvider(options)
      const errorHandler = jest.fn()
      provider.events.addHandler(ProviderEvents.Error, errorHandler)
      const { calls } = mockFetchDeferred()

      // Initialize first so provider is in READY state
      const init = provider.initialize({})
      calls[0].resolve(makeFetchResponse(makeResponse('init')))
      await init

      const first = provider.onContextChange({}, { targetingKey: 'user-1' })
      const second = provider.onContextChange({}, { targetingKey: 'user-2' })

      // First request errors — should be ignored since it's stale
      calls[1].reject(new Error('network failure'))
      // Flush microtask to let the stale check run
      await Promise.resolve()

      expect(errorHandler).not.toHaveBeenCalled()
      expect(provider.status).toBe(ProviderStatus.RECONCILING)

      // Second resolves normally — both settle
      calls[2].resolve(makeFetchResponse(makeResponse('second')))
      await Promise.all([first, second])
      expect(provider.status).toBe(ProviderStatus.READY)
    })

    it('stale call settles with same status as latest call when latest errors', async () => {
      const provider = new DatadogProvider(options)
      const errorHandler = jest.fn()
      provider.events.addHandler(ProviderEvents.Error, errorHandler)
      const { calls } = mockFetchDeferred()

      // Initialize first so provider is in READY state
      const init = provider.initialize({})
      calls[0].resolve(makeFetchResponse(makeResponse('init')))
      await init

      const first = provider.onContextChange({}, { targetingKey: 'user-1' })
      const second = provider.onContextChange({}, { targetingKey: 'user-2' })

      // Resolve stale, reject latest
      calls[1].resolve(makeFetchResponse(makeResponse('first')))
      calls[2].reject(new Error('network failure'))

      // Both reject together — stale chains to latest, so both reject with the same error
      await expect(Promise.all([first, second])).rejects.toThrow('network failure')

      expect(errorHandler).toHaveBeenCalledTimes(1)
      expect(provider.status).toBe(ProviderStatus.ERROR)
    })

    it('aborts superseded fetch with a descriptive DOMException reason', async () => {
      const provider = new DatadogProvider(options)
      const { calls, mock } = mockFetchDeferred()

      // Start first context update — fetch pauses waiting for resolution
      provider.onContextChange({}, { targetingKey: 'user-1' })
      // Flush microtasks so the fetch call is actually made
      await Promise.resolve()

      // Grab the AbortSignal that was passed to the first (now-stale) fetch
      const [, firstRequestInit] = mock.mock.calls[0]
      const supersededSignal: AbortSignal = firstRequestInit.signal

      // Fire second context update — this aborts the first signal
      provider.onContextChange({}, { targetingKey: 'user-2' })

      expect(supersededSignal.aborted).toBe(true)
      expect(supersededSignal.reason).toBeInstanceOf(DOMException)
      expect(supersededSignal.reason.name).toBe('AbortError')
      expect(supersededSignal.reason.message).toBe('Flag configuration fetch superseded by a newer context update')

      // Settle both in-flight fetches so the provider doesn't leak
      calls[0].resolve(makeFetchResponse(makeResponse('first')))
      calls[1].resolve(makeFetchResponse(makeResponse('second')))
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
