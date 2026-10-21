import { addTelemetryDebug, display } from '@datadog/browser-core'
import { type TimeStamp, timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { createFlagsConfigurationFetcher, fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import { fetchRulesConfiguration } from '../../src/transport/fetchRulesConfiguration'
import rulesWire from '../data/rules-v1-wire.json'

jest.mock('@datadog/js-core/time', () => ({
  timeStampNow: jest.fn(() => 1234567890),
}))

jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  addTelemetryDebug: jest.fn(),
}))

describe('createFlagsConfigurationFetcher', () => {
  let originalFetch: typeof global.fetch
  let mockFetch: jest.Mock

  beforeEach(() => {
    originalFetch = global.fetch
    mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: jest.fn((name: string) => {
          if (name === 'content-type') return 'application/vnd.api+json'
          return null
        }),
      },
      json: jest.fn().mockResolvedValue(validPrecomputedResponse),
    })
    global.fetch = mockFetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  const baseConfig: FlaggingInitConfiguration = {
    clientToken: 'test-token',
    applicationId: 'test-app-id',
    env: 'test',
  }

  const baseFetchOptions = {
    clientToken: 'test-token',
    applicationId: 'test-app-id',
    env: 'test',
  }

  const mockContext: EvaluationContext = {
    targetingKey: 'user-123',
    customAttr: 'value',
    numericAttr: 42,
    booleanAttr: true,
  }

  const validFlag = {
    allocationKey: 'allocation',
    variationKey: 'enabled',
    variationType: 'boolean',
    variationValue: true,
    reason: 'TARGETING_MATCH',
    doLog: true,
  }

  const validPrecomputedResponse = {
    data: {
      attributes: {
        createdAt: '2026-08-19T00:00:00.000Z',
        flags: {
          'test-flag': validFlag,
        },
      },
    },
  }

  describe('URL construction with flaggingProxy', () => {
    describe('when flaggingProxy has protocol', () => {
      const testCases = [
        {
          description: 'HTTP protocol',
          flaggingProxy: 'http://localhost:8080',
          expectedUrl: 'http://localhost:8080/?dd_env=test',
        },
        {
          description: 'HTTPS protocol',
          flaggingProxy: 'https://proxy.example.com',
          expectedUrl: 'https://proxy.example.com/?dd_env=test',
        },
        {
          description: 'HTTPS protocol with path',
          flaggingProxy: 'https://proxy.example.com/api/flags',
          expectedUrl: 'https://proxy.example.com/api/flags?dd_env=test',
        },
        {
          description: 'HTTP protocol with port and path',
          flaggingProxy: 'http://localhost:3000/proxy',
          expectedUrl: 'http://localhost:3000/proxy?dd_env=test',
        },
        {
          description: 'HTTP protocol with port, path and params',
          flaggingProxy: 'http://localhost:3000/proxy?foo=bar',
          expectedUrl: 'http://localhost:3000/proxy?foo=bar&dd_env=test',
        },
      ]

      test.each(testCases)('should use proxy URL as-is for $description', async ({ flaggingProxy, expectedUrl }) => {
        const config = { ...baseConfig, flaggingProxy }
        const fetcher = createFlagsConfigurationFetcher(config)

        await fetcher(mockContext)

        expect(mockFetch).toHaveBeenCalledWith(
          expectedUrl,
          expect.objectContaining({
            method: 'POST',
          })
        )
      })
    })

    describe('when flaggingProxy has no protocol', () => {
      const testCases = [
        {
          description: 'domain only',
          flaggingProxy: 'proxy.example.com',
          expectedUrl: 'https://proxy.example.com/?dd_env=test',
        },
        {
          description: 'domain with port',
          flaggingProxy: 'proxy.example.com:8080',
          expectedUrl: 'https://proxy.example.com:8080/?dd_env=test',
        },
        {
          description: 'localhost with port',
          flaggingProxy: 'localhost:3000',
          expectedUrl: 'https://localhost:3000/?dd_env=test',
        },
        {
          description: 'domain with path',
          flaggingProxy: 'proxy.example.com/api',
          expectedUrl: 'https://proxy.example.com/api?dd_env=test',
        },
      ]

      test.each(testCases)('should prepend https:// for $description', async ({ flaggingProxy, expectedUrl }) => {
        const config = { ...baseConfig, flaggingProxy }
        const fetcher = createFlagsConfigurationFetcher(config)

        await fetcher(mockContext)

        expect(mockFetch).toHaveBeenCalledWith(
          expectedUrl,
          expect.objectContaining({
            method: 'POST',
          })
        )
      })
    })

    describe('when no flaggingProxy is provided', () => {
      const testCases = [
        {
          description: 'default site',
          config: baseConfig,
          expectedUrl: 'https://preview.ff-cdn.datadoghq.com/precompute-assignments?dd_env=test',
        },
        {
          description: 'specific site',
          config: { ...baseConfig, site: 'datadoghq.eu' as const },
          expectedUrl: 'https://preview.ff-cdn.datadoghq.eu/precompute-assignments?dd_env=test',
        },
        {
          description: 'US3 site',
          config: { ...baseConfig, site: 'us3.datadoghq.com' as const },
          expectedUrl: 'https://preview.ff-cdn.us3.datadoghq.com/precompute-assignments?dd_env=test',
        },
      ]

      test.each(testCases)(
        'should use buildEndpointHost with /precompute-assignments for $description',
        async ({ config, expectedUrl }) => {
          const fetcher = createFlagsConfigurationFetcher(config)

          await fetcher(mockContext)

          expect(mockFetch).toHaveBeenCalledWith(
            expectedUrl,
            expect.objectContaining({
              method: 'POST',
            })
          )
        }
      )
    })
  })

  describe('request headers', () => {
    it('should declare capabilities to the Datadog edge', async () => {
      const fetcher = createFlagsConfigurationFetcher({ ...baseConfig, site: 'datadoghq.com' })

      await fetcher(mockContext)

      expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
        'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1',
      })
    })

    it('should not add a preflighted capabilities header to proxy requests unless configured', async () => {
      const proxy = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      await createFlagsConfigurationFetcher(proxy)(mockContext)
      await createFlagsConfigurationFetcher({
        ...proxy,
        customHeaders: { 'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1' },
      })(mockContext)

      expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('X-DD-FEATURE-FLAGS-CAPABILITIES')
      expect(mockFetch.mock.calls[1][1].headers).toMatchObject({
        'X-DD-FEATURE-FLAGS-CAPABILITIES': 'assignment-encoding-flag-key-256-v1',
      })
    })

    it('should include default headers when not overwriting', async () => {
      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/vnd.api+json',
            'dd-client-token': 'test-token',
            'dd-application-id': 'test-app-id',
          },
        })
      )
    })

    it('should exclude authentication headers when overwriteRequestHeaders is true', async () => {
      const config = {
        ...baseConfig,
        flaggingProxy: 'https://proxy.example.com',
        overwriteRequestHeaders: true,
      }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/vnd.api+json',
          },
        })
      )
    })

    it('should include custom headers', async () => {
      const config = {
        ...baseConfig,
        flaggingProxy: 'https://proxy.example.com',
        customHeaders: {
          'X-Custom-Header': 'custom-value',
          Authorization: 'Bearer token',
        },
      }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/vnd.api+json',
            'dd-client-token': 'test-token',
            'dd-application-id': 'test-app-id',
            'X-Custom-Header': 'custom-value',
            Authorization: 'Bearer token',
          },
        })
      )
    })

    it('should not include dd-application-id when applicationId is not provided', async () => {
      const config = {
        clientToken: 'test-token',
        env: 'test',
        flaggingProxy: 'https://proxy.example.com',
      }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/vnd.api+json',
            'dd-client-token': 'test-token',
          },
        })
      )
    })
  })

  describe('request body', () => {
    it('should include source payload with browser sdk_name and sdk_version', async () => {
      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"source":{"sdk_name":"browser","sdk_version":"1.0.0-test"}'),
        })
      )
    })

    it('should include env payload with dd_env but not name', async () => {
      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      const expectedBody = JSON.stringify({
        data: {
          type: 'precompute-assignments-request',
          attributes: {
            env: {
              dd_env: 'test',
            },
            source: {
              sdk_name: 'browser',
              sdk_version: '1.0.0-test',
            },
            subject: {
              targeting_key: 'user-123',
              targeting_attributes: {
                targetingKey: 'user-123',
                customAttr: 'value',
                numericAttr: '42',
                booleanAttr: 'true',
              },
            },
          },
        },
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expectedBody,
        })
      )
    })

    it('should not include name field in env payload', async () => {
      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      await fetcher(mockContext)

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.not.stringContaining('"name":"test"'),
        })
      )
    })
  })

  describe('return value', () => {
    it('should return precomputed configuration with context and timestamp', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: jest.fn((name: string) => {
            if (name === 'content-type') return 'application/vnd.api+json'
            return null
          }),
        },
        json: jest.fn().mockResolvedValue(validPrecomputedResponse),
      })

      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      const result = await fetcher(mockContext)

      expect(result).toEqual({
        precomputed: {
          response: validPrecomputedResponse,
          context: mockContext,
          fetchedAt: 1234567890 as TimeStamp,
        },
      })
    })

    it.each([
      ['null', null, 'Precomputed configuration response must be an object'],
      ['an empty object', {}, 'Precomputed configuration response is missing data'],
    ])('returns a parse error for %s', async (_, response, error) => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: jest.fn().mockResolvedValue(response),
      })

      const result = await fetchPrecomputedConfiguration({
        ...baseFetchOptions,
        context: mockContext,
      })

      expect(result).toEqual({ precomputedError: error })
    })

    it('preserves flags and records malformed flags', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: jest.fn().mockResolvedValue({
          data: {
            attributes: {
              createdAt: '2026-08-19T00:00:00.000Z',
              flags: {
                valid: validFlag,
                malformed: {},
              },
            },
          },
        }),
      })

      const result = await fetchPrecomputedConfiguration({
        ...baseFetchOptions,
        context: mockContext,
      })

      expect(result.precomputed?.response.data.attributes.flags).toEqual({ valid: validFlag, malformed: {} })
      expect(result.precomputed?.flagErrors).toEqual({ malformed: 'Invalid precomputed flag configuration' })
    })

    it('fetches a precomputed configuration directly', async () => {
      const customFetch = jest.fn().mockImplementation(async () => {
        expect(timeStampNow).toHaveBeenCalledTimes(1)
        return {
          ok: true,
          headers: new Headers(),
          json: jest.fn().mockResolvedValue(validPrecomputedResponse),
        }
      })

      const result = await fetchPrecomputedConfiguration({
        ...baseFetchOptions,
        context: mockContext,
        fetch: customFetch,
      })

      expect(result.precomputed?.context).toEqual(mockContext)
      expect(customFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('decodes a rules configuration response and includes source headers', async () => {
      const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
      const customFetch = jest.fn().mockImplementation(async () => {
        expect(timeStampNow).toHaveBeenCalledTimes(1)
        return {
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => bytes.buffer,
        }
      })

      const result = await fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch })

      expect(result.rules).toMatchObject({
        fetchedAt: 1234567890,
        response: { environmentName: 'prod' },
      })
      expect(customFetch).toHaveBeenCalledWith(
        'https://ufc-client.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/client?dd_env=test',
        expect.objectContaining({
          method: 'GET',
          headers: {
            Accept: 'application/protobuf',
            'DD-Client-Library-Language': 'browser',
            'DD-Client-Library-Version': '1.0.0-test',
            'dd-client-token': 'test-token',
          },
        })
      )
    })
  })

  describe('flagSelection', () => {
    let displayError: jest.SpyInstance

    beforeEach(() => {
      displayError = jest.spyOn(display, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
      displayError.mockRestore()
    })

    const requestBody = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body as string)

    const rulesResponse = (headers: Record<string, string> = {}) => {
      const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
      return { ok: true, headers: new Headers(headers), arrayBuffer: async () => bytes.buffer }
    }

    const rulesUrl = 'https://ufc-client.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/client'

    const expectNoTelemetryValues = (...values: string[]) => {
      const telemetry = JSON.stringify((addTelemetryDebug as jest.Mock).mock.calls)
      for (const value of values) expect(telemetry).not.toContain(value)
    }

    describe('precompute POST', () => {
      it('sends the canonical selection in the request body', async () => {
        const fetcher = createFlagsConfigurationFetcher({
          ...baseConfig,
          flagSelection: { tags: [' team:web ', 'beta', 'beta'], keyPatterns: ['ffe-*'] },
        })

        await fetcher(mockContext)

        expect(requestBody().data.attributes.flag_selection).toEqual({
          tags: ['beta', 'team:web'],
          key_patterns: ['ffe-*'],
        })
        expect(mockFetch.mock.calls[0][0]).toBe(
          'https://preview.ff-cdn.datadoghq.com/precompute-assignments?dd_env=test'
        )
        expect(displayError).not.toHaveBeenCalled()
        expect(addTelemetryDebug).not.toHaveBeenCalled()
      })

      it('sends the selection in the request body through flaggingProxy', async () => {
        const fetcher = createFlagsConfigurationFetcher({
          ...baseConfig,
          flaggingProxy: 'https://proxy.example.com',
          flagSelection: { tags: ['beta'] },
        })

        await fetcher(mockContext)

        expect(mockFetch.mock.calls[0][0]).toBe('https://proxy.example.com/?dd_env=test')
        expect(requestBody().data.attributes.flag_selection).toEqual({ tags: ['beta'], key_patterns: [] })
      })

      it.each([
        ['no selection', undefined],
        ['an empty selection', { tags: [' '], keyPatterns: [] }],
      ])('leaves the request unchanged for %s', async (_, flagSelection) => {
        await createFlagsConfigurationFetcher({ ...baseConfig, flagSelection })(mockContext)
        await createFlagsConfigurationFetcher(baseConfig)(mockContext)

        expect(mockFetch.mock.calls[0]).toEqual(mockFetch.mock.calls[1])
        expect(requestBody().data.attributes).not.toHaveProperty('flag_selection')
        expect(displayError).not.toHaveBeenCalled()
      })

      it.each([
        [
          'too_many_values',
          { tags: Array.from({ length: 32 }, (_, index) => `tag-${index}`) },
          'at most 31 values',
          'tag-0',
        ],
        ['invalid_tag', { tags: ['t'.repeat(201)] }, 'each tag is at most 200 UTF-8 bytes', 't'.repeat(201)],
        [
          'invalid_key_pattern',
          { keyPatterns: ['k'.repeat(201)] },
          'each key pattern is at most 200 UTF-8 bytes',
          'k'.repeat(201),
        ],
        ['malformed_selection', { tags: 'secret-tag' }, 'string arrays', 'secret-tag'],
      ])(
        'drops a %s selection, loads the full configuration, and reports it once',
        async (reason, flagSelection, limit, value) => {
          const fetcher = createFlagsConfigurationFetcher({
            ...baseConfig,
            flagSelection: flagSelection as FlaggingInitConfiguration['flagSelection'],
          })

          await expect(fetcher(mockContext)).resolves.toHaveProperty('precomputed')
          await fetcher(mockContext)

          expect(requestBody(0).data.attributes).not.toHaveProperty('flag_selection')
          expect(requestBody(1).data.attributes).not.toHaveProperty('flag_selection')
          expect(displayError).toHaveBeenCalledTimes(1)
          expect(displayError.mock.calls[0][0]).toContain(reason)
          expect(displayError.mock.calls[0][0]).toContain(limit)
          expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
          expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection dropped', { reason })
          expectNoTelemetryValues(value)
        }
      )

      it('reports a selection ignored by the server once per response and keeps the full configuration', async () => {
        mockFetch.mockResolvedValue({
          ok: true,
          headers: new Headers({ 'DD-Flag-Selection-Ignored': 'invalid_tag' }),
          json: jest.fn().mockResolvedValue(validPrecomputedResponse),
        })
        const fetcher = createFlagsConfigurationFetcher({ ...baseConfig, flagSelection: { tags: ['beta'] } })

        const result = await fetcher(mockContext)

        expect(result.precomputed?.response).toEqual(validPrecomputedResponse)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError.mock.calls[0][0]).toContain('invalid_tag')
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'invalid_tag' })
        expectNoTelemetryValues('beta')
      })
    })

    describe('rules-based GET', () => {
      it('appends repeated selection params to the existing query string', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())

        await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: customFetch,
          flagSelection: { tags: ['team:web', 'beta'], keyPatterns: ['checkout', 'ffe-*'] },
        })

        expect(customFetch).toHaveBeenCalledTimes(1)
        expect(customFetch.mock.calls[0][0]).toBe(
          `${rulesUrl}?dd_env=test&selected_flag_tags=beta&selected_flag_tags=team%3Aweb` +
            '&selected_flag_key_patterns=checkout&selected_flag_key_patterns=ffe-%2A'
        )
        expect(displayError).not.toHaveBeenCalled()
      })

      it.each([
        ['ffe-*', 'ffe-%2A'],
        ['a b', 'a%20b'],
        ['(x)!', '%28x%29%21'],
        ["it's", 'it%27s'],
        ['~a-b_c.d', '~a-b_c.d'],
        ['é', '%C3%A9'],
      ])('percent-encodes %j as %s', async (value, encoded) => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())

        await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: customFetch,
          flagSelection: { keyPatterns: [value] },
        })

        expect(customFetch.mock.calls[0][0]).toBe(`${rulesUrl}?dd_env=test&selected_flag_key_patterns=${encoded}`)
      })

      it('leaves the request unchanged without a selection', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())

        await fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch, flagSelection: { tags: [] } })

        expect(customFetch.mock.calls[0][0]).toBe(`${rulesUrl}?dd_env=test`)
      })

      it('drops an over-limit selection and loads the full configuration', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())

        const result = await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: customFetch,
          flagSelection: { tags: ['t'.repeat(201)] },
        })

        expect(result.rules).toBeDefined()
        expect(customFetch.mock.calls[0][0]).toBe(`${rulesUrl}?dd_env=test`)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection dropped', { reason: 'invalid_tag' })
      })

      it('sends one request without the selection when the URL would exceed 8192 bytes', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())
        const keyPatterns = Array.from({ length: 31 }, (_, index) => `${index}`.padEnd(200, '*'))

        const result = await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: customFetch,
          flagSelection: { keyPatterns },
        })

        expect(result.rules).toBeDefined()
        expect(customFetch).toHaveBeenCalledTimes(1)
        expect(customFetch.mock.calls[0][0]).toBe(`${rulesUrl}?dd_env=test`)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError.mock.calls[0][0]).toContain('too_many_values')
        expect(displayError.mock.calls[0][0]).toContain('8192 bytes')
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection dropped', { reason: 'too_many_values' })
        expectNoTelemetryValues(keyPatterns[0])
      })

      it('sends the selection when the URL is exactly 8192 bytes', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())
        const keyPatterns = Array.from({ length: 31 }, (_, index) => `${index}`.padEnd(200, 'k'))
        const patternsLength = keyPatterns.reduce(
          (total, pattern) => total + '&selected_flag_key_patterns='.length + pattern.length,
          0
        )
        const tagRoom = 8192 - `${rulesUrl}?dd_env=test`.length - patternsLength
        const tagCount = Math.ceil(tagRoom / 200)
        const tagValueBytes = tagRoom - tagCount * '&selected_flag_tags='.length
        const tags = Array.from({ length: tagCount }, (_, index) =>
          `${index}`.padEnd(Math.floor(tagValueBytes / tagCount) + (index < tagValueBytes % tagCount ? 1 : 0), 't')
        )

        await fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch, flagSelection: { tags, keyPatterns } })

        expect((customFetch.mock.calls[0][0] as string).length).toBe(8192)
        expect(displayError).not.toHaveBeenCalled()
      })

      it('reports a selection ignored by the server and keeps the full configuration', async () => {
        const customFetch = jest
          .fn()
          .mockResolvedValue(rulesResponse({ 'DD-Flag-Selection-Ignored': 'too_many_values' }))

        const result = await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: customFetch,
          flagSelection: { tags: ['beta'] },
        })

        expect(result.rules).toBeDefined()
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError.mock.calls[0][0]).toContain('too_many_values')
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'too_many_values' })
        expectNoTelemetryValues('beta')
      })
    })
  })

  describe('custom fetch implementation', () => {
    it('should use the configured fetch implementation instead of global fetch', async () => {
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: jest.fn((name: string) => (name === 'content-type' ? 'application/json' : null)) },
        json: jest.fn().mockResolvedValue(validPrecomputedResponse),
      })
      const fetcher = createFlagsConfigurationFetcher({ ...baseConfig, flagConfigurationFetch: customFetch })

      await expect(fetcher(mockContext)).resolves.toEqual({
        precomputed: {
          response: validPrecomputedResponse,
          context: mockContext,
          fetchedAt: 1234567890,
        },
      })
      expect(customFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('should forward the caller abort signal to the configured fetch implementation', async () => {
      const controller = new AbortController()
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: jest.fn((name: string) => (name === 'content-type' ? 'application/json' : null)) },
        json: jest.fn().mockResolvedValue(validPrecomputedResponse),
      })
      const fetcher = createFlagsConfigurationFetcher({ ...baseConfig, flagConfigurationFetch: customFetch })

      await fetcher(mockContext, { signal: controller.signal })

      expect(customFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal })
      )
    })
  })
})
