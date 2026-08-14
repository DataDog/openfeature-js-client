import type { TimeStamp } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { createFlagsConfigurationFetcher, fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import { fetchRulesConfiguration } from '../../src/transport/fetchRulesConfiguration'
import rulesWire from '../data/rules-v1-wire.json'

jest.mock('@datadog/js-core/time', () => ({
  timeStampNow: jest.fn(() => 1234567890),
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
      json: jest.fn().mockResolvedValue({ mockResponse: true }),
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

  const mockContext: EvaluationContext = {
    targetingKey: 'user-123',
    customAttr: 'value',
    numericAttr: 42,
    booleanAttr: true,
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

    it('should exclude dd headers when overwriteRequestHeaders is true', async () => {
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
      const mockResponse = { flags: { 'test-flag': 'value' } }
      mockFetch.mockResolvedValue({
        ok: true,
        headers: {
          get: jest.fn((name: string) => {
            if (name === 'content-type') return 'application/vnd.api+json'
            return null
          }),
        },
        json: jest.fn().mockResolvedValue(mockResponse),
      })

      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const fetcher = createFlagsConfigurationFetcher(config)

      const result = await fetcher(mockContext)

      expect(result).toEqual({
        precomputed: {
          response: mockResponse,
          context: mockContext,
          fetchedAt: 1234567890 as TimeStamp,
        },
      })
    })

    it('fetches a precomputed configuration directly', async () => {
      const config = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }

      const result = await fetchPrecomputedConfiguration({ ...config, context: mockContext })

      expect(result.precomputed?.context).toEqual(mockContext)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('reuses a previous precomputed configuration on a not-modified response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'precomputed-etag' }),
        json: jest.fn().mockResolvedValue({ mockResponse: true }),
      })
      const options = { ...baseConfig, flaggingProxy: 'https://proxy.example.com', context: mockContext }
      const previousConfiguration = await fetchPrecomputedConfiguration(options)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: new Headers(),
      })

      const result = await fetchPrecomputedConfiguration({ ...options, previousConfiguration })

      expect(result).toEqual(previousConfiguration)
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: expect.objectContaining({ 'If-None-Match': 'precomputed-etag' }) })
      )
    })

    it('decodes a rules configuration response and includes source headers', async () => {
      const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ etag: 'rules-etag' }),
        arrayBuffer: async () => bytes.buffer,
      })

      const result = await fetchRulesConfiguration({ ...baseConfig, flaggingProxy: 'https://proxy.example.com' })

      expect(result.rules).toMatchObject({
        fetchedAt: 1234567890,
        etag: 'rules-etag',
        response: { environmentName: 'prod' },
      })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/?dd_env=test',
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

    it('reuses a previous rules configuration on a not-modified response', async () => {
      const bytes = Uint8Array.from(Buffer.from(rulesWire.rules.response, 'base64'))
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ etag: 'rules-etag' }),
        arrayBuffer: async () => bytes.buffer,
      })
      const options = { ...baseConfig, flaggingProxy: 'https://proxy.example.com' }
      const previousConfiguration = await fetchRulesConfiguration(options)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: new Headers(),
      })

      const result = await fetchRulesConfiguration({ ...options, previousConfiguration })

      expect(result).toEqual(previousConfiguration)
      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: expect.objectContaining({ 'If-None-Match': 'rules-etag' }) })
      )
    })
  })
})
