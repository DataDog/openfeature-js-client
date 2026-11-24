import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import type { EvaluationContext, Logger } from '@openfeature/core'
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

    it('should still add the exposure recording hook when enableExposureLogging is false', () => {
      const providerWithoutExposures = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
      })
      // The exposure cache keeps recording for customer hooks; the option only
      // stops the batch send to Datadog.
      // 3 hooks: EVP flag evaluation + exposure recording + auto RUM tracking
      expect(providerWithoutExposures.hooks).toHaveLength(3)
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
      // 2 hooks: auto RUM tracking + exposure recording (always on)
      expect(providerWithMinHooks.hooks).toHaveLength(2)
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

    it('should keep the exposure recording hook when all other tracking options are disabled', () => {
      const providerWithNoHooks = new DatadogProvider({
        clientToken: 'xxx',
        applicationId: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      })
      // 1 hook: exposure recording (always on)
      expect(providerWithNoHooks.hooks).toHaveLength(1)
    })
  })

  describe('metadata', () => {
    beforeEach(() => {
      setupProvider()
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

    it('should return provider not ready before configuration is available', () => {
      const result = provider.resolveBooleanEvaluation('test-flag', true, mockContext, mockLogger)
      expect(result).toEqual({
        flagMetadata: { __dd_eval_timestamp_ms: expect.any(Number), __dd_observe_full_evaluation_data: false },
        value: true,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        errorMessage: 'No flags configuration has been set',
      })
    })

    it('should preserve configuration parse errors', () => {
      provider = new DatadogProvider({
        ...options,
        initialFlagsConfiguration: { rulesError: 'Malformed rules data' },
      })

      expect(provider.resolveBooleanEvaluation('test-flag', true, mockContext, mockLogger)).toEqual({
        flagMetadata: { __dd_eval_timestamp_ms: expect.any(Number), __dd_observe_full_evaluation_data: false },
        value: true,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
        errorMessage: 'Malformed rules data',
      })
    })
  })

  describe('resolveStringEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return provider not ready before configuration is available', () => {
      const result = provider.resolveStringEvaluation('test-flag', 'default', mockContext, mockLogger)
      expect(result).toEqual({
        flagMetadata: { __dd_eval_timestamp_ms: expect.any(Number), __dd_observe_full_evaluation_data: false },
        value: 'default',
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        errorMessage: 'No flags configuration has been set',
      })
    })
  })

  describe('resolveNumberEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return provider not ready before configuration is available', () => {
      const result = provider.resolveNumberEvaluation('test-flag', 42, mockContext, mockLogger)
      expect(result).toEqual({
        flagMetadata: { __dd_eval_timestamp_ms: expect.any(Number), __dd_observe_full_evaluation_data: false },
        value: 42,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        errorMessage: 'No flags configuration has been set',
      })
    })
  })

  describe('resolveObjectEvaluation', () => {
    beforeEach(() => {
      setupProvider()
    })

    it('should return provider not ready before configuration is available', () => {
      const defaultValue = { key: 'value' }
      const result = provider.resolveObjectEvaluation('test-flag', defaultValue, mockContext, mockLogger)
      expect(result).toEqual({
        flagMetadata: { __dd_eval_timestamp_ms: expect.any(Number), __dd_observe_full_evaluation_data: false },
        value: defaultValue,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        errorMessage: 'No flags configuration has been set',
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
      expect(url.toString()).toBe(
        `https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1`
      )
      expect(requestOptions.method).toBe('POST')

      // Verify headers were set correctly
      expect(requestOptions.headers).toEqual({
        'Content-Type': 'application/vnd.api+json',
        'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1',
        'dd-client-token': options.clientToken,
        'dd-application-id': options.applicationId,
      })

      // Parse the request body to verify contents are correct
      const requestBody = JSON.parse(requestOptions.body)
      const { diagnostics, ...assignmentRequest } = requestBody
      expect(diagnostics).toMatchObject({ fetch: { trigger: 'context_change' } })
      expect(assignmentRequest).toEqual({
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
          __dd_eval_timestamp_ms: expect.any(Number),
          __dd_observe_full_evaluation_data: false,
          __dd_allocation_key: 'allocation-123',
          __dd_do_log: true,
          __dd_exposure_cache_hit: false,
          allocationKey: 'allocation-123',
          doLog: true,
          variationType: 'STRING',
        },
      })
    })

    it.each([
      ['function', () => 1],
      ['symbol', Symbol('plan')],
    ])('does not merge a %s value with null', async (_type, plan) => {
      const context = { targetingKey: 'user', plan: null }
      await Promise.all([
        provider.onContextChange({}, context),
        provider.onContextChange(context, { ...context, plan: plan as unknown as null }),
      ])

      expect(
        fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body).data.attributes.subject.targeting_attributes)
      ).toEqual([{ targetingKey: 'user', plan: 'null' }, { targetingKey: 'user' }])
    })

    it.each([
      ['string', Object('pro'), '"pro"'],
      ['number', Object(7), '7'],
      ['boolean', Object(false), 'false'],
    ])('sends a boxed %s as supplied', async (_type, plan, expected) => {
      await provider.onContextChange({}, { targetingKey: 'user', plan })

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).data.attributes.subject.targeting_attributes.plan).toBe(
        expected
      )
    })

    it('preserves boxed values without reading a custom type tag', async () => {
      const tag = jest.fn(() => 'Object')
      const plan = Object.defineProperty(Object('pro'), Symbol.toStringTag, { get: tag })
      await provider.onContextChange({}, { targetingKey: 'user', plan })

      expect(tag).not.toHaveBeenCalled()
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).data.attributes.subject.targeting_attributes.plan).toBe(
        '"pro"'
      )
    })

    it('deduplicates plain toJSON data and Date subclasses with the default serializer', async () => {
      class NativeDate extends Date {}
      const context = () => ({ targetingKey: 'user', profile: { toJSON: 'data' }, date: new NativeDate(0) })

      await provider.onContextChange({}, context())
      await provider.onContextChange({}, context())

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('preserves custom Date serialization and refreshes when it changes', async () => {
      const timestamp = (label: string) => Object.defineProperty(new Date(0), 'toISOString', { value: () => label })
      const first = { targetingKey: 'user', date: timestamp('first') }
      const next = { targetingKey: 'user', date: timestamp('next') }

      await provider.onContextChange({}, first)
      await provider.onContextChange(first, next)

      expect(
        fetchMock.mock.calls.map(
          ([, request]) => JSON.parse(request.body).data.attributes.subject.targeting_attributes.date
        )
      ).toEqual(['"first"', '"next"'])
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

        // Explicitly supplying the existing RUM defaults leaves the effective request unchanged.
        await provider.onContextChange(
          {},
          {
            targetingKey: 'rum-user',
            user_email: 'explicit@example.com',
            company_name: 'Example, Inc.',
          }
        )
        expect(fetchMock).toHaveBeenCalledTimes(1)

        globalObject.DD_RUM.getUser = () => ({ id: 'next-rum-user' })
        await provider.onContextChange({}, { user_email: 'explicit@example.com' })
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).data.attributes.subject.targeting_key).toBe('next-rum-user')
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

    it('shares pending assignments and skips another fetch once the effective context is ready', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const first = { targetingKey: 'user', profile: { plan: 'team', dates: [new Date(0)] } }
      const equal = { profile: { dates: [new Date(0)], plan: 'team' }, targetingKey: 'user' }

      try {
        const initializing = provider.initialize(first)
        const duplicate = provider.onContextChange(first, equal)
        const signal: AbortSignal = mock.mock.calls[0][1].signal
        expect(mock).toHaveBeenCalledTimes(1)
        expect(signal.aborted).toBe(false)

        calls[0].resolve(makeFetchResponse(makeResponse('ready')))
        await Promise.all([initializing, duplicate])
        await provider.onContextChange(first, equal)
        expect(mock).toHaveBeenCalledTimes(1)
        expect(signal.aborted).toBe(false)
        expect(provider.status).toBe(ProviderStatus.READY)

        first.profile.dates[0].setTime(1000)
        const changed = provider.onContextChange(equal, first)
        expect(mock).toHaveBeenCalledTimes(2)
        calls[1].resolve(makeFetchResponse(makeResponse('changed')))
        await changed
      } finally {
        await provider.onClose()
      }
    })

    it('coalesces the same update submitted by a Reconciling listener', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const first = { targetingKey: 'ready' }
      const next = { targetingKey: 'next' }
      const initial = provider.initialize(first)
      calls[0].resolve(makeFetchResponse(makeResponse('ready')))
      await initial
      let duplicate: Promise<void> | undefined
      let called = false
      provider.events.addHandler(ProviderEvents.Reconciling, () => {
        if (!called) {
          called = true
          duplicate = provider.onContextChange(first, next)
        }
      })

      const updating = provider.onContextChange(first, next)
      for (const call of calls.slice(1)) call.resolve(makeFetchResponse(makeResponse('next')))
      await Promise.all([updating, duplicate])
      expect(mock).toHaveBeenCalledTimes(2)
      expect(duplicate).toBe(updating)
      await provider.onClose()
    })

    it('lets a Reconciling listener supersede the update with a different context', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const first = { targetingKey: 'ready' }
      const next = { targetingKey: 'next' }
      const final = { targetingKey: 'final' }

      try {
        const initial = provider.initialize(first)
        calls[0].resolve(makeFetchResponse(makeResponse('ready')))
        await initial

        let nested: Promise<void> | undefined
        let requestedFinal = false
        provider.events.addHandler(ProviderEvents.Reconciling, () => {
          if (!requestedFinal) {
            requestedFinal = true
            nested = provider.onContextChange(next, final)
          }
        })

        const updating = provider.onContextChange(first, next)
        expect(nested).toBeDefined()
        expect(
          mock.mock.calls.map(([, request]) => JSON.parse(request.body).data.attributes.subject.targeting_key)
        ).toEqual([first.targetingKey, final.targetingKey])

        calls[1].resolve(makeFetchResponse(makeResponse('final')))
        await Promise.all([updating, nested])
        expect(provider.status).toBe(ProviderStatus.READY)
        expect(provider.resolveStringEvaluation('string-flag', 'default', {}, console).value).toBe('final')
      } finally {
        await provider.onClose()
      }
    })

    it('keeps the normalized assignment token out of enumerable provider state', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const token = 'synthetic.review.token'
      const context = { targetingKey: 'user', dd_assignment_token: token }
      const updating = provider.onContextChange({}, context)
      expect(new Headers(mock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(token)
      const getEnumerableValues = () =>
        Object.values(provider).flatMap((value) =>
          typeof value === 'object' && value !== null ? Object.values(value) : [value]
        )
      expect(getEnumerableValues()).not.toContain(token)
      calls[0].resolve(makeFetchResponse(makeResponse('ready')))
      await updating
      expect(getEnumerableValues()).not.toContain(token)
    })

    it('shares the pending rejection with an equal context submitted synchronously by custom fetch', async () => {
      const context = { targetingKey: 'user' }
      let duplicate!: Promise<void>
      let failFetch!: (error: Error) => void
      const flagConfigurationFetch = jest.fn(() => {
        duplicate = provider.onContextChange(context, { ...context })
        return new Promise<Response>((_resolve, reject) => {
          failFetch = reject
        })
      })
      const provider = new DatadogProvider({ ...options, flagConfigurationFetch })

      const original = provider.onContextChange({}, context)
      const outcome = Promise.allSettled([original, duplicate])
      const error = new Error('custom fetch failed')
      failFetch(error)

      expect(flagConfigurationFetch).toHaveBeenCalledTimes(1)
      expect(await outcome).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
      ])
    })

    it('coalesces equal pending credentials and supersedes the fetch when the credential changes', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const first = { targetingKey: 'user', dd_assignment_token: 'first.token' }
      const replacement = { ...first, dd_assignment_token: 'replacement.token' }

      const updating = provider.onContextChange({}, first)
      const duplicate = provider.onContextChange(first, { ...first })
      const signal: AbortSignal = mock.mock.calls[0][1].signal
      expect(duplicate).toBe(updating)
      expect(mock).toHaveBeenCalledTimes(1)
      expect(signal.aborted).toBe(false)

      const changed = provider.onContextChange(first, replacement)
      expect(mock).toHaveBeenCalledTimes(2)
      expect(signal.aborted).toBe(true)
      expect(new Headers(mock.mock.calls[1][1].headers).get('DD-Assignment-Token')).toBe('replacement.token')
      calls[0].resolve(makeFetchResponse(makeResponse('superseded')))
      calls[1].resolve(makeFetchResponse(makeResponse('ready')))
      await Promise.all([updating, duplicate, changed])
      await provider.onContextChange(replacement, { ...replacement })
      expect(mock).toHaveBeenCalledTimes(2)

      const removed = provider.onContextChange(replacement, { targetingKey: 'user' })
      expect(mock).toHaveBeenCalledTimes(3)
      expect(new Headers(mock.mock.calls[2][1].headers).has('DD-Assignment-Token')).toBe(false)
      calls[2].resolve(makeFetchResponse(makeResponse('removed')))
      await removed
    })

    it('retries the same context when the shared request fails', async () => {
      const provider = new DatadogProvider(options)
      const { mock, calls } = mockFetchDeferred()
      const context = { targetingKey: 'user' }
      const first = provider.onContextChange({}, context)
      const duplicate = provider.onContextChange(context, { ...context })
      expect(duplicate).toBe(first)
      expect(mock).toHaveBeenCalledTimes(1)

      calls[0].reject(new Error('network failure'))
      await expect(duplicate).rejects.toThrow('network failure')
      expect(provider.status).toBe(ProviderStatus.ERROR)

      const retry = provider.onContextChange(context, { ...context })
      expect(mock).toHaveBeenCalledTimes(2)
      calls[1].resolve(makeFetchResponse(makeResponse('recovered')))
      await retry
      expect(provider.status).toBe(ProviderStatus.READY)
    })

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
      const networkError = new Error('network failure')
      calls[1].resolve(makeFetchResponse(makeResponse('first')))
      calls[2].reject(networkError)

      // Both reject together — stale chains to latest, so both reject with the same error
      await expect(Promise.all([first, second])).rejects.toThrow('network failure')

      expect(errorHandler).toHaveBeenCalledWith({ error: networkError, message: 'network failure' })
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

  describe('initialization without applicationId', () => {
    it('should initialize successfully', async () => {
      const originalFetch = global.fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => precomputedResponse,
      })
      const testProvider = new DatadogProvider({
        clientToken: 'xxx',
        env: 'test',
        site: INTAKE_SITE_STAGING,
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      })

      try {
        await expect(testProvider.initialize()).resolves.toBeUndefined()
        expect(testProvider.status).toBe(ProviderStatus.READY)
      } finally {
        global.fetch = originalFetch
      }
    })
  })

  describe('custom configuration fetch implementation', () => {
    let originalFetch: typeof global.fetch

    beforeAll(() => {
      originalFetch = global.fetch
    })

    afterAll(() => {
      global.fetch = originalFetch
    })

    it('uses flagConfigurationFetch during provider initialization', async () => {
      const globalFetch = jest.fn(() => {
        throw new Error('global fetch should not be called')
      })
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: jest.fn(),
        },
        json: async () => precomputedResponse,
      })
      global.fetch = globalFetch
      mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

      const testProvider = new DatadogProvider({
        ...options,
        flagConfigurationFetch: customFetch,
      })
      const context = { targetingKey: 'custom-fetch-user' }

      await expect(testProvider.initialize(context)).resolves.toBeUndefined()

      expect(globalFetch).not.toHaveBeenCalled()
      expect(customFetch).toHaveBeenCalledWith(
        'https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/vnd.api+json',
            'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1',
            'dd-client-token': options.clientToken,
            'dd-application-id': options.applicationId,
          },
        })
      )
      expect(testProvider.status).toBe(ProviderStatus.READY)
      expect(testProvider.resolveStringEvaluation('string-flag', 'default', context, mockLogger).value).toBe('red')
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
            message: 'Context change fetch failed',
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
