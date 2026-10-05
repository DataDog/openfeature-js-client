import { evaluate } from '@datadog/flagging-core'
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
import wire from '../../browser/test/data/rules-v1-wire.json'
import {
  ConfigurationFetchError,
  fetchRulesConfiguration,
  type RulesConfigurationFetchOptions,
} from '../src/configuration/fetch-rules-configuration'

const body = Buffer.from(wire.rules.response, 'base64')
const headers = { 'Content-Type': 'application/protobuf', ETag: wire.rules.etag }
const options = { apiKey: 'server-key', env: 'prod' }

function response(bytes = body): Response {
  return new Response(Uint8Array.from(bytes), { headers })
}

describe('fetchRulesConfiguration', () => {
  const requestFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()

  beforeEach(() => {
    jest.useFakeTimers()
    requestFetch.mockReset().mockImplementation(async () => response())
  })

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it.each([undefined, 'server'] as const)('uses the server endpoint for distribution %s', async (distribution) => {
    const result = await fetchRulesConfiguration({ ...options, distribution, fetch: requestFetch })
    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(requestFetch).toHaveBeenCalledWith(
      'https://ufc-server.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/server?dd_env=prod',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: {
          Accept: 'application/protobuf',
          'dd-api-key': options.apiKey,
          'DD-Client-Library-Language': 'nodejs',
          'DD-Client-Library-Version': '1.0.0-test',
        },
      })
    )
    expect(result.rules).toMatchObject({ etag: wire.rules.etag, fetchedAt: Date.now() })
    expect(result.rules?.response.environmentName).toBe('prod')
  })

  it.each(
    ['us3.datadoghq.com', 'datad0g.com'].flatMap((site) =>
      ['client', 'server'].map((distribution) => ({ site, distribution }))
    )
  )('uses $distribution authentication on $site', async ({ site, distribution }) => {
    const credentials =
      distribution === 'client'
        ? ({ distribution: 'client', clientToken: 'client-token' } as const)
        : ({ distribution: 'server', apiKey: 'server-key' } as const)
    await fetchRulesConfiguration({
      ...credentials,
      env: 'test & preview',
      site,
      fetch: requestFetch,
    })
    expect(requestFetch).toHaveBeenCalledWith(
      `https://ufc-${distribution}.ff-cdn.${site}/api/v2/feature-flagging/config/rules-based/${distribution}?dd_env=test+%26+preview`,
      expect.objectContaining({
        headers: {
          Accept: 'application/protobuf',
          [distribution === 'client' ? 'dd-client-token' : 'dd-api-key']:
            distribution === 'client' ? 'client-token' : 'server-key',
          'DD-Client-Library-Language': 'nodejs',
          'DD-Client-Library-Version': '1.0.0-test',
        },
      })
    )
  })

  it('uses global fetch by default and a custom transport when supplied', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    await fetchRulesConfiguration(options)
    await fetchRulesConfiguration({ ...options, fetch: requestFetch })
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(requestFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    { distribution: 'client' },
    { distribution: 'all' },
    { distribution: null },
    { clientToken: 'token' },
    { apiKey: undefined, clientToken: 'token' },
    { distribution: 'client', clientToken: 'token' },
    { apiKey: undefined },
    { apiKey: '' },
    { apiKey: 'secret\r\nheader' },
    { env: '' },
    { env: undefined },
    { site: 'datadoghq.com.attacker.invalid' },
    { site: 'datadoghq.com/path' },
    { site: 'ddog-gov.com' },
    { site: 'constructor' },
    { site: '__proto__' },
    { site: 'toString' },
    { site: null },
    { site: {} },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: Infinity },
    { timeoutMs: 2147483648 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: Infinity },
    { maxResponseBytes: 1.5 },
  ])('rejects invalid options before sending credentials: %j', async (override) => {
    await expect(
      fetchRulesConfiguration({ ...options, ...override, fetch: requestFetch } as RulesConfigurationFetchOptions)
    ).rejects.toMatchObject({ code: 'invalid_options', message: 'Invalid configuration fetch options' })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('rejects missing options and a missing fetch implementation', async () => {
    await expect(fetchRulesConfiguration(undefined as unknown as RulesConfigurationFetchOptions)).rejects.toMatchObject(
      { code: 'invalid_options' }
    )
    const original = globalThis.fetch
    try {
      globalThis.fetch = undefined as unknown as typeof fetch
      await expect(fetchRulesConfiguration(options)).rejects.toMatchObject({ code: 'invalid_options' })
    } finally {
      globalThis.fetch = original
    }
  })

  it('returns a parsed configuration for evaluation and serialization', async () => {
    const configuration = await fetchRulesConfiguration({ ...options, fetch: requestFetch })
    const context = { targetingKey: 'user-1', country: 'US' }
    expect(evaluate(configuration, 'boolean', 'test-flag', false, context)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    })
    configuration.rules!.response.environmentName = 'changed'
    expect(configurationFromString(configurationToString(configuration))).toEqual(configuration)
  })

  it.each([204, 301, 302, 304, 401, 403, 404, 429, 500])(
    'rejects HTTP %i without exposing its body',
    async (status) => {
      requestFetch.mockResolvedValue(new Response([204, 304].includes(status) ? null : 'secret', { status }))
      await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
        code: 'http',
        status,
        message: `Configuration fetch returned HTTP ${status}`,
      })
      expect(requestFetch).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['application/json', 'text/html', ''])('rejects an unexpected content type: %s', async (contentType) => {
    requestFetch.mockResolvedValue(new Response(body, { headers: { 'Content-Type': contentType } }))
    await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('accepts MIME parameters and responses without an ETag', async () => {
    requestFetch.mockResolvedValue(
      new Response(body, { headers: { 'Content-Type': 'Application/Protobuf; charset=binary' } })
    )
    const result = await fetchRulesConfiguration({ ...options, fetch: requestFetch })
    expect(result.rules?.etag).toBeUndefined()
  })

  it.each([null, ''])('rejects an empty response (%j)', async (value) => {
    requestFetch.mockResolvedValue(new Response(value, { headers }))
    await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('rejects malformed protobuf', async () => {
    requestFetch.mockResolvedValue(response(Buffer.from([0xff])))
    await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({ code: 'decode' })
  })

  it.each([new Error('secret'), new ConfigurationFetchError('http', 'secret')])(
    'sanitizes transport failures',
    async (error) => {
      requestFetch.mockRejectedValue(error)
      const pending = fetchRulesConfiguration({ ...options, fetch: requestFetch })
      await expect(pending).rejects.toMatchObject({ code: 'transport', message: 'Configuration request failed' })
      await expect(pending).rejects.not.toHaveProperty('cause')
    }
  )

  it('sanitizes body-read failures', async () => {
    requestFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(stream) {
            stream.error(new Error('secret'))
          },
        }),
        { headers }
      )
    )
    await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'transport',
      message: 'Configuration response could not be read',
    })
  })

  it.each(['http', 'mime', 'content-length', 'chunks'])('releases rejected %s responses', async (failure) => {
    const cancel = jest.fn()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        if (failure === 'chunks') {
          stream.enqueue(new Uint8Array(3))
          stream.enqueue(new Uint8Array(3))
        }
      },
      cancel,
    })
    requestFetch.mockResolvedValue(
      new Response(body, {
        status: failure === 'http' ? 403 : 200,
        headers: {
          'Content-Type': failure === 'mime' ? 'text/plain' : 'application/protobuf',
          ...(failure === 'content-length' ? { 'Content-Length': '6' } : {}),
        },
      })
    )
    await expect(
      fetchRulesConfiguration({ ...options, maxResponseBytes: 5, fetch: requestFetch })
    ).rejects.toBeInstanceOf(ConfigurationFetchError)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(requestFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('enforces the limit on decoded chunks even when Content-Length is smaller', async () => {
    requestFetch.mockResolvedValue(new Response(body, { headers: { ...headers, 'Content-Length': '1' } }))
    await expect(
      fetchRulesConfiguration({ ...options, maxResponseBytes: body.length - 1, fetch: requestFetch })
    ).rejects.toMatchObject({ code: 'response_too_large' })
    requestFetch.mockResolvedValue(response())
    await expect(
      fetchRulesConfiguration({ ...options, maxResponseBytes: body.length, fetch: requestFetch })
    ).resolves.toHaveProperty('rules')
  })

  it('rejects an already cancelled call without fetching', async () => {
    const controller = new AbortController()
    controller.abort(new Error('secret'))
    await expect(
      fetchRulesConfiguration({ ...options, signal: controller.signal, fetch: requestFetch })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it.each(['headers', 'body'])('supports timeout and cancellation while waiting for %s', async (phase) => {
    for (const reason of ['timeout', 'cancelled']) {
      const controller = new AbortController()
      const removeListener = jest.spyOn(controller.signal, 'removeEventListener')
      requestFetch.mockImplementation((_url, request) => {
        const signal = request!.signal!
        if (phase === 'headers') {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('secret')), { once: true })
          })
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(stream) {
                signal.addEventListener('abort', () => stream.error(new Error('secret')), { once: true })
              },
            }),
            { headers }
          )
        )
      })
      const pending = fetchRulesConfiguration({
        ...options,
        signal: controller.signal,
        timeoutMs: 50,
        fetch: requestFetch,
      })
      const check = expect(pending).rejects.toMatchObject({ code: reason })
      if (reason === 'timeout') await jest.advanceTimersByTimeAsync(50)
      else controller.abort(new Error('secret'))
      await check
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    }
  })

  it('removes the caller listener after success', async () => {
    const controller = new AbortController()
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener')
    await fetchRulesConfiguration({ ...options, signal: controller.signal, fetch: requestFetch })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
