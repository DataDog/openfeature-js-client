import { addTelemetryDebug, display } from '@datadog/browser-core'
import { type TimeStamp, timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { withRetry } from '../../src/transport/fetch'
import {
  buildConfigurationHeaders,
  createFlagsConfigurationFetcher,
  fetchPrecomputedConfiguration,
} from '../../src/transport/fetchConfiguration'
import { fetchRulesConfiguration } from '../../src/transport/fetchRulesConfiguration'
import { createResponseSigningController } from '../../src/transport/responseSigning/controller'
import { ResponseVerificationError } from '../../src/transport/responseSigning/verification'
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
      text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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
          expectedUrl: 'http://localhost:8080/?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'HTTPS protocol',
          flaggingProxy: 'https://proxy.example.com',
          expectedUrl: 'https://proxy.example.com/?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'HTTPS protocol with path',
          flaggingProxy: 'https://proxy.example.com/api/flags',
          expectedUrl: 'https://proxy.example.com/api/flags?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'HTTP protocol with port and path',
          flaggingProxy: 'http://localhost:3000/proxy',
          expectedUrl: 'http://localhost:3000/proxy?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'HTTP protocol with port, path and params',
          flaggingProxy: 'http://localhost:3000/proxy?foo=bar',
          expectedUrl: 'http://localhost:3000/proxy?foo=bar&dd_env=test&cap_dependent-flags-variant-key=v1',
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
          expectedUrl: 'https://proxy.example.com/?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'domain with port',
          flaggingProxy: 'proxy.example.com:8080',
          expectedUrl: 'https://proxy.example.com:8080/?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'localhost with port',
          flaggingProxy: 'localhost:3000',
          expectedUrl: 'https://localhost:3000/?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'domain with path',
          flaggingProxy: 'proxy.example.com/api',
          expectedUrl: 'https://proxy.example.com/api?dd_env=test&cap_dependent-flags-variant-key=v1',
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
          expectedUrl:
            'https://preview.ff-cdn.datadoghq.com/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'specific site',
          config: { ...baseConfig, site: 'datadoghq.eu' as const },
          expectedUrl:
            'https://preview.ff-cdn.datadoghq.eu/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1',
        },
        {
          description: 'US3 site',
          config: { ...baseConfig, site: 'us3.datadoghq.com' as const },
          expectedUrl:
            'https://preview.ff-cdn.us3.datadoghq.com/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1',
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
        text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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
        text: jest.fn().mockResolvedValue(JSON.stringify(response)),
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
        text: jest.fn().mockResolvedValue(
          JSON.stringify({
            data: {
              attributes: {
                createdAt: '2026-08-19T00:00:00.000Z',
                flags: {
                  valid: validFlag,
                  malformed: {},
                },
              },
            },
          })
        ),
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
          text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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
            'dd-application-id': 'test-app-id',
          },
        })
      )
    })

    it('does not send dd-application-id on a rules request without applicationId', async () => {
      const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        arrayBuffer: async () => bytes.buffer,
      })
      const { applicationId: _, ...options } = baseFetchOptions

      await fetchRulesConfiguration({ ...options, fetch: customFetch })

      expect(customFetch.mock.calls[0][1].headers).not.toHaveProperty('dd-application-id')
    })
  })

  describe('buildConfigurationHeaders', () => {
    it.each(['precomputed', 'rules'] as const)('sends dd-application-id on %s requests', (endpoint) => {
      expect(
        buildConfigurationHeaders({ clientToken: 'test-token', applicationId: 'app-id' }, {}, endpoint)
      ).toMatchObject({ 'dd-application-id': 'app-id' })
    })

    it.each(['precomputed', 'rules'] as const)(
      'does not send dd-application-id on %s requests with overwriteRequestHeaders',
      (endpoint) => {
        expect(
          buildConfigurationHeaders(
            { clientToken: 'test-token', applicationId: 'app-id', overwriteRequestHeaders: true },
            {},
            endpoint
          )
        ).toEqual({})
      }
    )

    it.each([
      ['precomputed', 'dd-application-id'],
      ['precomputed', 'DD-Application-ID'],
      ['rules', 'DD-APPLICATION-ID'],
      ['rules', 'Dd-Application-Id'],
    ] as const)('lets a custom %s header named %s replace applicationId', (endpoint, name) => {
      const headers = buildConfigurationHeaders(
        { clientToken: 'test-token', applicationId: 'automatic-app', customHeaders: { [name]: 'manual-app' } },
        {},
        endpoint
      )

      expect(new Headers(headers).get('dd-application-id')).toBe('manual-app')
      expect(headers).toMatchObject({ [name]: 'manual-app' })
    })

    describe('dd-service', () => {
      const endpoints = ['precomputed', 'rules'] as const

      // serviceHeader.spec.ts checks which values fetch accepts, with the platform Headers.
      it.each(endpoints)('sends the service on %s requests', (endpoint) => {
        for (const service of ['checkout', '_svc', 'My-Service', 'web-store.v2:prod/api', 'my service']) {
          expect(buildConfigurationHeaders({ clientToken: 'test-token', service }, {}, endpoint)).toMatchObject({
            'dd-service': service,
          })
        }
      })

      it.each(endpoints)('sends no header on %s requests without a service', (endpoint) => {
        for (const service of [undefined, null, '']) {
          expect(buildConfigurationHeaders({ clientToken: 'test-token', service }, {}, endpoint)).not.toHaveProperty(
            'dd-service'
          )
        }
      })

      it.each(endpoints)('sends no header on %s requests with overwriteRequestHeaders', (endpoint) => {
        expect(
          buildConfigurationHeaders(
            { clientToken: 'test-token', service: 'checkout', overwriteRequestHeaders: true },
            {},
            endpoint
          )
        ).toEqual({})
      })

      it.each(endpoints)('sends no header through a proxy on %s requests unless configured', (endpoint) => {
        const proxy = { clientToken: 'test-token', service: 'checkout', flaggingProxy: 'https://proxy.example.com' }

        expect(buildConfigurationHeaders(proxy, {}, endpoint)).not.toHaveProperty('dd-service')
        expect(
          buildConfigurationHeaders({ ...proxy, customHeaders: { 'dd-service': 'checkout' } }, {}, endpoint)
        ).toMatchObject({ 'dd-service': 'checkout' })
      })

      it.each([
        ['precomputed', 'DD-Service'],
        ['precomputed', 'DD-SERVICE'],
        ['rules', 'Dd-Service'],
        ['rules', 'dd-Service'],
      ] as const)('lets a custom %s header named %s replace service', (endpoint, name) => {
        const headers = buildConfigurationHeaders(
          { clientToken: 'test-token', service: 'automatic-service', customHeaders: { [name]: 'manual-service' } },
          {},
          endpoint
        )

        expect(new Headers(headers).get('dd-service')).toBe('manual-service')
        expect(headers).toMatchObject({ [name]: 'manual-service' })
      })

      it('lets a custom header replace the provider service on precomputed requests', async () => {
        await createFlagsConfigurationFetcher({
          ...baseConfig,
          service: 'automatic-service',
          customHeaders: { 'DD-Service': 'manual-service' },
        })(mockContext)

        expect(new Headers(mockFetch.mock.calls[0][1].headers).get('dd-service')).toBe('manual-service')
      })

      it('sends the provider service on precomputed requests', async () => {
        await createFlagsConfigurationFetcher({ ...baseConfig, service: 'checkout' })(mockContext)

        expect(mockFetch.mock.calls[0][1].headers).toMatchObject({ 'dd-service': 'checkout' })
      })

      it('sends the service on standalone rules requests', async () => {
        const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
        const customFetch = jest.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          arrayBuffer: async () => bytes.buffer,
        })

        await fetchRulesConfiguration({ ...baseFetchOptions, service: 'checkout', fetch: customFetch })

        expect(customFetch.mock.calls[0][1].headers).toMatchObject({ 'dd-service': 'checkout' })
      })
    })
  })

  describe('flagSelection', () => {
    let displayError: jest.SpyInstance

    beforeEach(() => {
      displayError = jest.spyOn(display, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
      jest.restoreAllMocks()
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
          'https://preview.ff-cdn.datadoghq.com/precompute-assignments?dd_env=test&cap_dependent-flags-variant-key=v1'
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

        expect(mockFetch.mock.calls[0][0]).toBe(
          'https://proxy.example.com/?dd_env=test&cap_dependent-flags-variant-key=v1'
        )
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
          text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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

      it('reports a selection ignored by the server once when the request is retried', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0)
        const ignoredHeaders = { 'DD-Flag-Selection-Ignored': 'invalid_tag' }
        const customFetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(ignoredHeaders) })
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(ignoredHeaders),
            text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
          })
        const fetcher = createFlagsConfigurationFetcher({
          ...baseConfig,
          flagSelection: { tags: ['beta'] },
          flagConfigurationFetch: withRetry(customFetch, 1),
        })

        await fetcher(mockContext)

        expect(customFetch).toHaveBeenCalledTimes(2)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'invalid_tag' })
      })

      it('does not read the ignored header when no selection was sent', async () => {
        const headers = new Headers({ 'DD-Flag-Selection-Ignored': 'invalid_tag' })
        const getHeader = jest.spyOn(headers, 'get')
        mockFetch.mockResolvedValue({
          ok: true,
          headers,
          text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
        })

        await createFlagsConfigurationFetcher(baseConfig)(mockContext)

        expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
        expect(displayError).not.toHaveBeenCalled()
        expect(addTelemetryDebug).not.toHaveBeenCalled()
      })
    })

    describe('standalone precompute POST', () => {
      it('reports a reflected ignored header as unknown when the context carries an assignment token', async () => {
        const token = 'private.jwt.signature'
        const headers = new Headers({ 'DD-Flag-Selection-Ignored': `DD-Assignment-Token=${token}` })
        mockFetch.mockResolvedValue({
          ok: true,
          headers,
          text: async () => JSON.stringify(await validPrecomputedResponse),
        })

        await fetchPrecomputedConfiguration({
          ...baseFetchOptions,
          context: { ...mockContext, dd_assignment_token: token },
          flagSelection: { tags: ['beta'] },
        })

        expect(new Headers(mockFetch.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(token)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError.mock.calls[0][0]).not.toContain(token)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'unknown' })
        expectNoTelemetryValues(token)
      })

      it('accepts readonly tags and key patterns and sends their canonical selection', async () => {
        await fetchPrecomputedConfiguration({
          ...baseFetchOptions,
          context: mockContext,
          flagSelection: { tags: [' beta ', 'beta'], keyPatterns: ['checkout-*'] } as const,
        })
        expect(requestBody().data.attributes.flag_selection).toEqual({ tags: ['beta'], key_patterns: ['checkout-*'] })
        expect(displayError).not.toHaveBeenCalled()
        expect(addTelemetryDebug).not.toHaveBeenCalled()
      })

      it.each([undefined, { tags: [' '], keyPatterns: [] }])(
        'preserves requests with no effective selection: %j',
        async (flagSelection) => {
          await fetchPrecomputedConfiguration({ ...baseFetchOptions, context: mockContext, flagSelection })
          await fetchPrecomputedConfiguration({ ...baseFetchOptions, context: mockContext })
          expect(mockFetch.mock.calls[0]).toEqual(mockFetch.mock.calls[1])
          expect(requestBody().data.attributes).not.toHaveProperty('flag_selection')
          expect(displayError).not.toHaveBeenCalled()
        }
      )

      it.each([
        ['too_many_values', { tags: Array.from({ length: 32 }, (_, index) => `tag-${index}`) }],
        ['invalid_tag', { tags: ['t'.repeat(201)] }],
        ['invalid_key_pattern', { keyPatterns: ['k'.repeat(201)] }],
        ['malformed_selection', { tags: 'secret-tag' }],
      ])('drops %s selections and reports once per standalone call', async (reason, flagSelection) => {
        const options = {
          ...baseFetchOptions,
          context: mockContext,
          flagSelection: flagSelection as FlaggingInitConfiguration['flagSelection'],
        }
        await expect(fetchPrecomputedConfiguration(options)).resolves.toHaveProperty('precomputed')
        await fetchPrecomputedConfiguration(options)
        expect(requestBody(0).data.attributes).not.toHaveProperty('flag_selection')
        expect(requestBody(1).data.attributes).not.toHaveProperty('flag_selection')
        expect(displayError).toHaveBeenCalledTimes(2)
        expect(addTelemetryDebug).toHaveBeenCalledTimes(2)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection dropped', { reason })
        expectNoTelemetryValues('tag-0', 'secret-tag', 't'.repeat(201), 'k'.repeat(201))
      })

      it.each([true, false])('reports an ignored selection only when one was sent: %s', async (selected) => {
        const headers = new Headers({ 'DD-Flag-Selection-Ignored': 'invalid_tag' })
        const getHeader = jest.spyOn(headers, 'get')
        mockFetch.mockResolvedValue({
          ok: true,
          headers,
          text: async () => JSON.stringify(await validPrecomputedResponse),
        })
        const result = await fetchPrecomputedConfiguration({
          ...baseFetchOptions,
          context: mockContext,
          flagSelection: selected ? { tags: ['beta'] } : undefined,
        })
        expect(result.precomputed?.response).toEqual(validPrecomputedResponse)
        expect(displayError).toHaveBeenCalledTimes(selected ? 1 : 0)
        if (selected) {
          expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'invalid_tag' })
        } else {
          expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
          expect(addTelemetryDebug).not.toHaveBeenCalled()
        }
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

      it('reports a selection ignored by the server once when the request is retried', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0)
        const ignoredHeaders = { 'DD-Flag-Selection-Ignored': 'too_many_values' }
        const customFetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(ignoredHeaders) })
          .mockResolvedValueOnce({ ...rulesResponse(ignoredHeaders), status: 200 })

        await fetchRulesConfiguration({
          ...baseFetchOptions,
          fetch: withRetry(customFetch, 1),
          flagSelection: { tags: ['beta'] },
        })

        expect(customFetch).toHaveBeenCalledTimes(2)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'too_many_values' })
      })

      it('does not read the ignored header when no selection was sent', async () => {
        const response = rulesResponse({ 'DD-Flag-Selection-Ignored': 'too_many_values' })
        const getHeader = jest.spyOn(response.headers, 'get')
        const customFetch = jest.fn().mockResolvedValue(response)

        await fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch })

        expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
        expect(displayError).not.toHaveBeenCalled()
        expect(addTelemetryDebug).not.toHaveBeenCalled()
      })

      it('reports a dropped selection on every call', async () => {
        const customFetch = jest.fn().mockResolvedValue(rulesResponse())
        const options = { ...baseFetchOptions, fetch: customFetch, flagSelection: { tags: ['t'.repeat(201)] } }

        await fetchRulesConfiguration(options)
        await fetchRulesConfiguration(options)

        expect(displayError).toHaveBeenCalledTimes(2)
        expect(addTelemetryDebug).toHaveBeenCalledTimes(2)
        expect(addTelemetryDebug).toHaveBeenNthCalledWith(2, 'Flag selection dropped', { reason: 'invalid_tag' })
      })
    })

    describe('ignored header', () => {
      const ignoredMessage = (reason: string) =>
        `flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`

      // Returns the value exactly as given; a Headers object would normalize surrounding whitespace.
      const rawIgnoredHeader = (value: string) => ({
        get: (name: string) => (name.toLowerCase() === 'dd-flag-selection-ignored' ? value : null),
      })

      const fetchWithSelection = (headers: unknown) => {
        mockFetch.mockResolvedValue({
          ok: true,
          status: 200,
          headers,
          text: async () => JSON.stringify(await validPrecomputedResponse),
        })
        return createFlagsConfigurationFetcher({ ...baseConfig, flagSelection: { tags: ['beta'] } })(mockContext)
      }

      it.each(['malformed_selection', 'too_many_values', 'invalid_key_pattern', 'invalid_tag', 'tag_load_failed'])(
        'reports the known reason %s as received',
        async (reason) => {
          await expect(fetchWithSelection(rawIgnoredHeader(reason))).resolves.toHaveProperty('precomputed')

          expect(displayError).toHaveBeenCalledTimes(1)
          expect(displayError).toHaveBeenCalledWith(ignoredMessage(reason))
          expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
          expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason })
        }
      )

      it.each([
        ['a differently cased reason', 'Too_Many_Values'],
        ['an upper-case reason', 'INVALID_TAG'],
        ['a reason with a trailing space', 'too_many_values '],
        ['a reason with a leading space', ' invalid_tag'],
        ['a reason with a trailing tab', 'invalid_tag\t'],
        ['a whitespace-only value', ' '],
        ['a reason this SDK does not know', 'reason_from_a_newer_server'],
        ['two reasons joined with a comma', 'invalid_tag,too_many_values'],
        ['two reasons joined as repeated fields', 'invalid_tag, too_many_values'],
        // Fetch joins repeated fields with ", ", including empty ones. The whatwg-fetch polyfill used here skips empty
        // values when joining, so these two are given as the joined strings a browser returns.
        ['an empty field followed by a reason', ', invalid_tag'],
        ['two empty fields', ', '],
        ['the former redaction placeholder', 'redacted'],
        ['a 33-character value', 'a'.repeat(33)],
        ['a 33-character value that starts with a known reason', `tag_load_failed${'_'.repeat(18)}`],
        ['a very long value', 'x'.repeat(100_000)],
        ['a reflected request header', 'DD-Assignment-Token=private.jwt.signature'],
      ])('reports %s as unknown, never the raw value', async (_description, value) => {
        await expect(fetchWithSelection(rawIgnoredHeader(value))).resolves.toHaveProperty('precomputed')

        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError).toHaveBeenCalledWith(ignoredMessage('unknown'))
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'unknown' })
      })

      it.each([
        ['distinct repeated fields', ['invalid_tag', 'tag_load_failed']],
        ['identical repeated fields', ['invalid_tag', 'invalid_tag']],
      ])('reports %s as unknown', async (_description, fields) => {
        const headers = new Headers()
        for (const field of fields) headers.append('DD-Flag-Selection-Ignored', field)

        await fetchWithSelection(headers)

        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError).toHaveBeenCalledWith(ignoredMessage('unknown'))
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'unknown' })
      })

      it.each([
        ['an empty raw value', rawIgnoredHeader('')],
        ['an empty header field', new Headers({ 'DD-Flag-Selection-Ignored': '' })],
      ])('treats %s as absent', async (_description, headers) => {
        await expect(fetchWithSelection(headers)).resolves.toHaveProperty('precomputed')

        expect(displayError).not.toHaveBeenCalled()
        expect(addTelemetryDebug).not.toHaveBeenCalled()
      })

      it('reports an unknown value from the rules endpoint as unknown', async () => {
        const customFetch = jest
          .fn()
          .mockResolvedValue(rulesResponse({ 'DD-Flag-Selection-Ignored': 'reason_from_a_newer_server' }))

        await fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch, flagSelection: { tags: ['beta'] } })

        expect(displayError).toHaveBeenCalledWith(ignoredMessage('unknown'))
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'unknown' })
        expectNoTelemetryValues('reason_from_a_newer_server')
      })

      const ignoredHeaders = () => new Headers({ 'DD-Flag-Selection-Ignored': 'invalid_tag' })
      const immediateOptOut = { experimentationOptOutMode: ExperimentationOptOutMode.Immediate }
      const optedOutContext = { ...mockContext, dd_experimentation_opt_out_at: '2026-10-19T12:00:00Z' }
      const withEvaluationOptions = (evaluationOptions?: Record<string, unknown>) => ({
        data: {
          attributes: {
            ...validPrecomputedResponse.data.attributes,
            ...(evaluationOptions && { evaluation_options: evaluationOptions }),
          },
        },
      })
      const acknowledgedResponse = withEvaluationOptions({
        experimentation_opt_out: true,
        experimentation_opt_out_mode: 'immediate',
      })

      const nowSeconds = () => Math.floor(Date.now() / 1000)
      const proofScope = { anchorKey: '0'.repeat(64), leafNotBefore: 0, verifiedResponseHeaders: {} }
      const proofAt = (verifiedAt: number, expiresAt: number) => ({
        verifiedAt,
        effectiveVerifiedAt: verifiedAt,
        verifiedMonotonicMs: performance.now(),
        issuedAt: verifiedAt,
        expiresAt,
        ...proofScope,
      })
      const validProof = () => proofAt(nowSeconds(), nowSeconds() + 300)
      const expiredProof = () => proofAt(nowSeconds() - 600, nowSeconds() - 300)

      // jsdom lacks WebCrypto, so prepare and most reads are stubbed; admit, the gate under test, runs for real.
      const requiredSigning = () => {
        const signing = createResponseSigningController(
          { mode: 'required', trustedRootCertificates: ['test-root'] },
          { site: 'datad0g.com' }
        )!
        jest
          .spyOn(signing, 'prepare')
          .mockResolvedValue({ url: '', method: 'POST', headers: new Headers(), body: new Uint8Array() })
        return signing
      }

      it('reports once when an opted-out subject receives an acknowledged, signed configuration', async () => {
        const signing = requiredSigning()
        // The SDK reports the verified value from the proof, not the raw header.
        const proof = { ...validProof(), verifiedResponseHeaders: { 'dd-flag-selection-ignored': 'invalid_tag' } }
        jest.spyOn(signing, 'read').mockResolvedValue({ json: acknowledgedResponse, proof })
        mockFetch.mockResolvedValue({ ok: true, status: 200, redirected: false, headers: ignoredHeaders() })
        const fetcher = createFlagsConfigurationFetcher(
          { ...baseConfig, ...immediateOptOut, flagSelection: { tags: ['beta'] } },
          signing
        )

        const configuration = await fetcher(optedOutContext)

        expect(signing.isVerified(configuration, optedOutContext)).toBe(true)
        expect(displayError).toHaveBeenCalledTimes(1)
        expect(displayError).toHaveBeenCalledWith(ignoredMessage('invalid_tag'))
        expect(addTelemetryDebug).toHaveBeenCalledTimes(1)
        expect(addTelemetryDebug).toHaveBeenCalledWith('Flag selection ignored', { reason: 'invalid_tag' })
      })

      describe('when the configuration is not accepted', () => {
        it.each([
          [
            'the body is not JSON',
            async () => {
              throw new SyntaxError('Unexpected token')
            },
          ],
          ['the body is not a precomputed configuration', async () => ({ data: null })],
        ])('does not report when %s', async (_description, json) => {
          mockFetch.mockResolvedValue({ ok: true, status: 200, headers: ignoredHeaders(), json })
          const fetcher = createFlagsConfigurationFetcher({ ...baseConfig, flagSelection: { tags: ['beta'] } })

          await expect(fetcher(mockContext)).rejects.toThrow()

          expect(displayError).not.toHaveBeenCalled()
          expect(addTelemetryDebug).not.toHaveBeenCalled()
        })

        it('does not report when the standalone fetch returns a parse error', async () => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: ignoredHeaders(),
            text: async () => JSON.stringify({}),
          })

          const result = await fetchPrecomputedConfiguration({
            ...baseFetchOptions,
            context: mockContext,
            flagSelection: { tags: ['beta'] },
          })

          expect(result.precomputedError).toBeDefined()
          expect(displayError).not.toHaveBeenCalled()
          expect(addTelemetryDebug).not.toHaveBeenCalled()
        })

        it('does not report when the rules response cannot be decoded', async () => {
          const customFetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: ignoredHeaders(),
            arrayBuffer: async () => Uint8Array.from([0xff, 0xff, 0xff, 0xff]).buffer,
          })

          await expect(
            fetchRulesConfiguration({ ...baseFetchOptions, fetch: customFetch, flagSelection: { tags: ['beta'] } })
          ).rejects.toThrow()

          expect(displayError).not.toHaveBeenCalled()
          expect(addTelemetryDebug).not.toHaveBeenCalled()
        })

        it.each([
          ['an opted-out subject receives no acknowledgement', optedOutContext, withEvaluationOptions()],
          [
            'an opted-out subject receives an acknowledgement for another mode',
            optedOutContext,
            withEvaluationOptions({
              experimentation_opt_out: true,
              experimentation_opt_out_mode: 'future_experiments_only',
            }),
          ],
          ['a subject that did not opt out receives an acknowledgement', mockContext, acknowledgedResponse],
        ])('does not report when %s', async (_description, context, body) => {
          mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: ignoredHeaders(),
            text: async () => JSON.stringify(await body),
          })
          const fetcher = createFlagsConfigurationFetcher({
            ...baseConfig,
            ...immediateOptOut,
            flagSelection: { tags: ['beta'] },
          })

          await expect(fetcher(context)).rejects.toThrow('did not acknowledge experimentation opt-out')

          expect(displayError).not.toHaveBeenCalled()
          expect(addTelemetryDebug).not.toHaveBeenCalled()
        })

        describe('by response signing', () => {
          const fetchSigned = (
            signing: ReturnType<typeof requiredSigning>,
            { redirected = false, signal }: { redirected?: boolean; signal?: AbortSignal } = {}
          ) => {
            mockFetch.mockResolvedValue({ ok: true, status: 200, redirected, headers: ignoredHeaders() })
            return createFlagsConfigurationFetcher({ ...baseConfig, flagSelection: { tags: ['beta'] } }, signing)(
              mockContext,
              { signal }
            )
          }

          it('does not report when verification rejects the response', async () => {
            const signing = requiredSigning()
            jest.spyOn(signing, 'read').mockRejectedValue(new ResponseVerificationError('invalid-proof'))

            await expect(fetchSigned(signing)).rejects.toThrow(ResponseVerificationError)

            expect(displayError).not.toHaveBeenCalled()
            expect(addTelemetryDebug).not.toHaveBeenCalled()
          })

          it('does not report when read rejects a redirected response', async () => {
            await expect(fetchSigned(requiredSigning(), { redirected: true })).rejects.toThrow(
              'redirects are not supported'
            )

            expect(displayError).not.toHaveBeenCalled()
            expect(addTelemetryDebug).not.toHaveBeenCalled()
          })

          it('does not report when admission rejects an expired proof', async () => {
            const signing = requiredSigning()
            jest.spyOn(signing, 'read').mockResolvedValue({ json: validPrecomputedResponse, proof: expiredProof() })

            await expect(fetchSigned(signing)).rejects.toThrow('expired-proof')

            expect(displayError).not.toHaveBeenCalled()
            expect(addTelemetryDebug).not.toHaveBeenCalled()
          })

          it('does not report when the request is cancelled before admission', async () => {
            const signing = requiredSigning()
            const controller = new AbortController()
            jest.spyOn(signing, 'read').mockImplementation(async () => {
              controller.abort()
              return { json: validPrecomputedResponse, proof: validProof() }
            })

            await expect(fetchSigned(signing, { signal: controller.signal })).rejects.toMatchObject({
              name: 'AbortError',
            })

            expect(displayError).not.toHaveBeenCalled()
            expect(addTelemetryDebug).not.toHaveBeenCalled()
          })
        })
      })
    })
  })

  describe('custom fetch implementation', () => {
    it('should use the configured fetch implementation instead of global fetch', async () => {
      const customFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: jest.fn((name: string) => (name === 'content-type' ? 'application/json' : null)) },
        text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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
        text: jest.fn().mockResolvedValue(JSON.stringify(validPrecomputedResponse)),
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
