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

function stalledFetch(phase: string): typeof fetch {
  return (_url, request) => {
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
  }
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
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: NaN },
    { timeoutMs: Infinity },
    { timeoutMs: 2147483648 },
    { timeoutMs: '5000' },
    { timeoutMs: null },
    { site: 'datadoghq.com.attacker.invalid' },
    { site: 'datadoghq.com/path' },
    { site: 'ddog-gov.com' },
    { site: 'constructor' },
    { site: '__proto__' },
    { site: 'toString' },
    { site: null },
    { site: {} },
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

  it.each(
    [
      { code: 'ENOTFOUND', suffix: ' (ENOTFOUND)' },
      { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', suffix: ' (DEPTH_ZERO_SELF_SIGNED_CERT)' },
      { code: 'UND_ERR_HEADERS_TIMEOUT', suffix: ' (UND_ERR_HEADERS_TIMEOUT)' },
      { code: 'UND_ERR_BODY_TIMEOUT', suffix: ' (UND_ERR_BODY_TIMEOUT)' },
      { code: 'KEY_0123ABCD', suffix: '' },
      { code: 'secret value', suffix: '' },
      { code: 123, suffix: '' },
    ].flatMap((testCase) =>
      ['direct', 'cause'].flatMap((location) => ['request', 'body'].map((phase) => ({ ...testCase, location, phase })))
    )
  )('keeps only a known $phase error code from $location: $code', async ({ code, suffix, location, phase }) => {
    const source = Object.assign(new Error('secret'), { code, data: 'secret response' })
    const error = location === 'cause' ? Object.assign(new TypeError('secret request'), { cause: source }) : source
    if (phase === 'request') {
      requestFetch.mockRejectedValue(error)
    } else {
      const result = response()
      jest.spyOn(result, 'arrayBuffer').mockRejectedValue(error)
      requestFetch.mockResolvedValue(result)
    }
    const message = phase === 'request' ? 'Configuration request failed' : 'Configuration response could not be read'
    const pending = fetchRulesConfiguration({ ...options, fetch: requestFetch })
    await expect(pending).rejects.toMatchObject({ code: 'transport', message: `${message}${suffix}` })
    await expect(pending).rejects.not.toHaveProperty('cause')
    await expect(pending).rejects.not.toHaveProperty('data')
  })

  it.each(
    [
      { failure: 'http', code: 'http' },
      { failure: 'mime', code: 'invalid_response' },
    ].flatMap((testCase) => ['settles', 'never settles', 'rejects'].map((cleanup) => ({ ...testCase, cleanup })))
  )('preserves $failure errors when cancellation $cleanup', async ({ failure, code, cleanup }) => {
    const cancel = jest.fn(() => {
      if (cleanup === 'never settles') return new Promise<void>(() => {})
      if (cleanup === 'rejects') return Promise.reject(new Error('secret'))
    })
    const body = new ReadableStream<Uint8Array>({ cancel })
    requestFetch.mockResolvedValue(
      new Response(body, {
        status: failure === 'http' ? 403 : 200,
        headers: {
          'Content-Type': failure === 'mime' ? 'text/plain' : 'application/protobuf',
        },
      })
    )
    const controller = new AbortController()
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener')
    const rejected = jest.fn()
    const pending = fetchRulesConfiguration({
      ...options,
      signal: controller.signal,
      fetch: requestFetch,
    }).catch(rejected)
    await jest.advanceTimersByTimeAsync(0)
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: 'ConfigurationFetchError', code }))
    await pending
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
    expect(requestFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('decodes a streamed response', async () => {
    requestFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(stream) {
            const midpoint = Math.floor(body.length / 2)
            stream.enqueue(body.subarray(0, midpoint))
            stream.enqueue(body.subarray(midpoint))
            stream.close()
          },
        }),
        { headers }
      )
    )
    await expect(fetchRulesConfiguration({ ...options, fetch: requestFetch })).resolves.toHaveProperty('rules')
  })

  it.each([
    { reason: new Error('secret'), code: 'cancelled', message: 'Configuration fetch cancelled' },
    { reason: new DOMException('secret', 'TimeoutError'), code: 'timeout', message: 'Configuration fetch timed out' },
  ])('rejects an already $code call without fetching', async ({ reason, code, message }) => {
    const controller = new AbortController()
    controller.abort(reason)
    await expect(
      fetchRulesConfiguration({ ...options, signal: controller.signal, fetch: requestFetch })
    ).rejects.toMatchObject({ code, message })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it.each(
    ['headers', 'body'].flatMap((phase) =>
      [undefined, 25].map((timeoutMs) => ({ phase, timeoutMs, deadline: timeoutMs ?? 5000 }))
    )
  )('times out after $deadline ms while waiting for $phase', async ({ phase, timeoutMs, deadline }) => {
    requestFetch.mockImplementation(stalledFetch(phase))
    const pending = fetchRulesConfiguration({ ...options, timeoutMs, fetch: requestFetch })
    const rejected = jest.fn()
    const settled = pending.catch(rejected)
    await jest.advanceTimersByTimeAsync(deadline - 1)
    expect(rejected).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await settled
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'timeout', message: 'Configuration fetch timed out' })
    )
    expect(requestFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it.each(
    ['headers', 'body'].flatMap((phase) =>
      [
        { reason: new DOMException('secret', 'AbortError'), code: 'cancelled' },
        { reason: new DOMException('secret', 'TimeoutError'), code: 'timeout' },
      ].map((testCase) => ({ ...testCase, phase }))
    )
  )('honors caller $code while waiting for $phase', async ({ phase, reason, code }) => {
    const controller = new AbortController()
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener')
    requestFetch.mockImplementation(stalledFetch(phase))
    const pending = fetchRulesConfiguration({ ...options, signal: controller.signal, fetch: requestFetch })
    const rejected = jest.fn()
    const settled = pending.catch(rejected)
    await jest.advanceTimersByTimeAsync(2500)
    expect(rejected).not.toHaveBeenCalled()
    expect(requestFetch.mock.calls[0][1]?.signal?.aborted).toBe(false)
    controller.abort(reason)
    await settled
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code }))
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('uses one deadline for headers and body together', async () => {
    requestFetch.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      return stalledFetch('body')(...args)
    })
    const rejected = jest.fn()
    const pending = fetchRulesConfiguration({ ...options, fetch: requestFetch }).catch(rejected)
    await jest.advanceTimersByTimeAsync(4999)
    expect(rejected).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await pending
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'timeout' }))
  })

  it('removes the caller listener after success', async () => {
    const controller = new AbortController()
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener')
    await fetchRulesConfiguration({ ...options, signal: controller.signal, fetch: requestFetch })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
