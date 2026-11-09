import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { evaluate } from '@datadog/flagging-core'
import {
  ConfigurationFetchError,
  configurationFromString,
  configurationToString,
  fetchPrecomputedConfiguration,
  getPrecomputedContext,
  type PrecomputedConfigurationFetchOptions,
} from '../src'
import {
  ConfigurationFetchError as RulesFetchError,
  fetchPrecomputedConfiguration as rulesFetch,
} from '../src/rules-based'

const capability = 'assignment-encoding-flag-key-256-v1'
const optOutAt = '2026-11-06T12:00:00.123456789Z'
const context = {
  targetingKey: 'subject',
  country: 'US',
  count: 3,
  nested: { tags: ['a'] },
  enabled: true,
  empty: null,
}
const options: PrecomputedConfigurationFetchOptions = {
  distributionChannel: 'client',
  clientToken: 'test-token',
  env: 'prod',
  context,
}
const assignment = {
  allocationKey: 'allocation',
  variationKey: 'on',
  variationType: 'boolean',
  variationValue: true,
  doLog: true,
  reason: 'TARGETING_MATCH',
  serialId: 7,
}
const salt = '000102030405060708090a0b0c0d0e0f'
const encodedKey = createHash('sha256')
  .update('datadog.feature-flags.flag-key.v1\0')
  .update(Buffer.from(salt, 'hex'))
  .update('test-flag')
  .digest('hex')

function response(
  encoded = false,
  headers: Record<string, string> = {},
  evaluationOptions?: Record<string, unknown>
): Response {
  return new Response(
    JSON.stringify({
      data: {
        attributes: {
          createdAt: '2026-11-06T12:00:00Z',
          format: 'PRECOMPUTED',
          obfuscated: encoded,
          ...(encoded && { obfuscation: { scheme: 'flag-key-sha256-v1', salt } }),
          ...(evaluationOptions && { evaluation_options: evaluationOptions }),
          flags: { [encoded ? encodedKey : 'test-flag']: assignment },
        },
      },
    }),
    { headers: { 'Content-Type': 'application/vnd.api+json', ETag: 'response-etag', ...headers } }
  )
}

function stalledFetch(phase: string): typeof fetch {
  return (_url, request) => {
    const signal = request!.signal!
    if (phase === 'headers')
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('private data')), { once: true })
      })
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener('abort', () => stream.error(new Error('private data')), { once: true })
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    )
  }
}

describe('fetchPrecomputedConfiguration', () => {
  const requestFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-06T12:00:00Z'))
    requestFetch.mockReset().mockImplementation(async () => response())
  })
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('is exported from root and /rules-based with one shared fetch error class', () => {
    expect(rulesFetch).toBe(fetchPrecomputedConfiguration)
    expect(RulesFetchError).toBe(ConfigurationFetchError)
  })

  it('maps client credentials, context, environment and target compatibility to the existing endpoint', async () => {
    const result = await fetchPrecomputedConfiguration({
      ...options,
      env: 'test & preview',
      site: 'datad0g.com',
      applicationId: 'app',
      clientCompatibility: { capabilities: [capability, 'unknown-v1', capability] },
      fetch: requestFetch,
    })
    expect(requestFetch).toHaveBeenCalledTimes(1)
    const [url, init] = requestFetch.mock.calls[0]
    expect(url).toBe('https://preview.ff-cdn.datad0g.com/precompute-assignments?dd_env=test+%26+preview')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'dd-client-token': 'test-token',
        'dd-application-id': 'app',
        'X-DD-FEATURE-FLAGS-CAPABILITIES': capability,
      },
    })
    expect(JSON.parse(init!.body as string)).toEqual({
      data: {
        type: 'precompute-assignments-request',
        attributes: {
          env: { dd_env: 'test & preview' },
          source: { sdk_name: 'nodejs', sdk_version: '1.0.0-test' },
          subject: {
            targeting_key: 'subject',
            targeting_attributes: {
              targetingKey: 'subject',
              country: 'US',
              count: '3',
              nested: '{"tags":["a"]}',
              enabled: 'true',
              empty: 'null',
            },
          },
        },
      },
    })
    expect(result.precomputed).toMatchObject({ context, fetchedAt: Date.now(), etag: 'response-etag' })
    expect(getPrecomputedContext(result)).toEqual(context)
    const restored = configurationFromString(configurationToString(result))
    expect(evaluate(restored, 'boolean', 'test-flag', false, context)).toMatchObject({ value: true, variant: 'on' })
  })

  it('omits etag when a successful response has none', async () => {
    const withoutEtag = response()
    withoutEtag.headers.delete('etag')
    requestFetch.mockResolvedValue(withoutEtag)
    const result = await fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })
    expect(result.precomputed).not.toHaveProperty('etag')
  })

  describe.each(['immediate', 'future_experiments_only'] as const)('experimentation opt-out: %s', (mode) => {
    const optedOutContext = { ...context, dd_experimentation_opt_out_at: optOutAt }
    const optedOutOptions = { ...options, context: optedOutContext, experimentationOptOutMode: mode }

    it('sends the effective policy and preserves acknowledged snapshots through serialization', async () => {
      requestFetch.mockResolvedValue(
        response(
          false,
          {},
          {
            experimentation_opt_out: true,
            experimentation_opt_out_mode: mode,
            dd_experimentation_opt_out_at: optOutAt,
          }
        )
      )
      const result = await fetchPrecomputedConfiguration({ ...optedOutOptions, fetch: requestFetch })
      const request = JSON.parse(requestFetch.mock.calls[0][1]!.body as string).data.attributes
      expect(request.evaluation_options).toEqual({ experimentation_opt_out_mode: mode })
      expect(request.subject.targeting_attributes.dd_experimentation_opt_out_at).toBe(optOutAt)
      const restored = configurationFromString(configurationToString(result))
      expect(evaluate(restored, 'boolean', 'test-flag', false, optedOutContext, undefined, mode)).toMatchObject({
        value: true,
        variant: 'on',
      })
    })

    it('omits the policy when the context has no opt-out timestamp', async () => {
      await fetchPrecomputedConfiguration({ ...options, experimentationOptOutMode: mode, fetch: requestFetch })
      expect(JSON.parse(requestFetch.mock.calls[0][1]!.body as string).data.attributes).not.toHaveProperty(
        'evaluation_options'
      )
    })

    it.each([null, 'private invalid timestamp', '2026-02-30T00:00:00Z'])(
      'rejects an invalid opt-out timestamp before fetching: %j',
      async (timestamp) => {
        await expect(
          fetchPrecomputedConfiguration({
            ...optedOutOptions,
            context: { ...context, dd_experimentation_opt_out_at: timestamp },
            fetch: requestFetch,
          })
        ).rejects.toMatchObject({ code: 'invalid_options', message: expect.not.stringContaining('private') })
        expect(requestFetch).not.toHaveBeenCalled()
      }
    )

    it('rejects a missing response acknowledgment', async () => {
      await expect(fetchPrecomputedConfiguration({ ...optedOutOptions, fetch: requestFetch })).rejects.toMatchObject({
        code: 'decode',
        message: 'The assignment response did not acknowledge experimentation opt-out',
      })
    })
  })

  it.each([undefined, 'disabled'] as const)('does not apply opt-out in mode %s', async (mode) => {
    await fetchPrecomputedConfiguration({
      ...options,
      context: { ...context, dd_experimentation_opt_out_at: 'ignored invalid timestamp' },
      experimentationOptOutMode: mode,
      fetch: requestFetch,
    })
    expect(JSON.parse(requestFetch.mock.calls[0][1]!.body as string).data.attributes).not.toHaveProperty(
      'evaluation_options'
    )
  })

  it('accepts the legacy immediate opt-out acknowledgment', async () => {
    requestFetch.mockResolvedValue(response(false, {}, { experimentation_opt_out: true }))
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        context: { ...context, dd_experimentation_opt_out_at: optOutAt },
        experimentationOptOutMode: 'immediate',
        fetch: requestFetch,
      })
    ).resolves.toHaveProperty('precomputed')
  })

  it.each([false, 'true', 1])('rejects an invalid immediate opt-out acknowledgment: %j', async (acknowledgment) => {
    requestFetch.mockResolvedValue(response(false, {}, { experimentation_opt_out: acknowledgment }))
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        context: { ...context, dd_experimentation_opt_out_at: optOutAt },
        experimentationOptOutMode: 'immediate',
        fetch: requestFetch,
      })
    ).rejects.toMatchObject({ code: 'decode' })
  })

  it.each([
    {
      experimentation_opt_out_mode: 'future_experiments_only',
      dd_experimentation_opt_out_at: '2026-11-06T12:00:00.123456788Z',
    },
    {
      experimentation_opt_out_mode: 'immediate',
      experimentation_opt_out: true,
      dd_experimentation_opt_out_at: optOutAt,
    },
  ])('rejects a mismatched future-only opt-out acknowledgment: %j', async (acknowledgment) => {
    requestFetch.mockResolvedValue(response(false, {}, acknowledgment))
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        context: { ...context, dd_experimentation_opt_out_at: optOutAt },
        experimentationOptOutMode: 'future_experiments_only',
        fetch: requestFetch,
      })
    ).rejects.toMatchObject({ code: 'decode' })
  })

  it('accepts an equivalent normalized future-only cutoff and snapshots the requested policy', async () => {
    const inputContext = { ...context, dd_experimentation_opt_out_at: '2026-11-06T08:00:00.123456789-04:00' }
    requestFetch.mockImplementation(async () => {
      inputContext.dd_experimentation_opt_out_at = '2026-11-07T00:00:00Z'
      return response(
        false,
        {},
        {
          experimentation_opt_out_mode: 'future_experiments_only',
          dd_experimentation_opt_out_at: optOutAt,
        }
      )
    })
    const result = await fetchPrecomputedConfiguration({
      ...options,
      context: inputContext,
      experimentationOptOutMode: 'future_experiments_only',
      fetch: requestFetch,
    })
    expect(result.precomputed!.context!.dd_experimentation_opt_out_at).toBe('2026-11-06T08:00:00.123456789-04:00')
  })

  it('rejects an opt-out acknowledgment when exclusion was not requested', async () => {
    requestFetch.mockResolvedValue(response(false, {}, { experimentation_opt_out: true }))
    await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'decode',
    })
  })

  it.each([undefined, { capabilities: [] }, { capabilities: ['unknown-v1', 'dependent-flag-variant-key-v1'] }])(
    'does not substitute Node capabilities for %j',
    async (clientCompatibility) => {
      await fetchPrecomputedConfiguration({ ...options, clientCompatibility, fetch: requestFetch })
      expect(requestFetch.mock.calls[0][1]!.headers).not.toHaveProperty('X-DD-FEATURE-FLAGS-CAPABILITIES')
    }
  )

  it.each([false, true])('accepts plaintext or encoded output for an encoding-capable client: %s', async (encoded) => {
    requestFetch.mockImplementation(async () =>
      response(encoded, { 'Content-Type': 'application/json; charset=utf-8' })
    )
    const result = await fetchPrecomputedConfiguration({
      ...options,
      clientCompatibility: { capabilities: [capability] },
      fetch: requestFetch,
    })
    const restored = configurationFromString(configurationToString(result))
    expect(evaluate(restored, 'boolean', 'test-flag', false, context)).toMatchObject({
      value: true,
      variant: 'on',
      flagMetadata: { __dd_split_serial_id: 7, doLog: true },
    })
    expect(result.precomputed!.response.data.attributes.obfuscated).toBe(encoded)
  })

  it.each([undefined, { capabilities: [] }, { capabilities: ['future-v1'] }])(
    'rejects a response encoding the target did not advertise: %j',
    async (clientCompatibility) => {
      requestFetch.mockImplementation(async () => response(true))
      await expect(
        fetchPrecomputedConfiguration({ ...options, clientCompatibility, fetch: requestFetch })
      ).rejects.toMatchObject({ code: 'decode' })
    }
  )

  it('uses global fetch by default', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    await fetchPrecomputedConfiguration(options)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('snapshots compatibility and context before fetching', async () => {
    const inputContext = { targetingKey: 'subject', nested: { tags: ['a'] } }
    const clientCompatibility = { capabilities: [capability] }
    requestFetch.mockImplementation(async () => {
      inputContext.targetingKey = 'changed'
      inputContext.nested.tags.push('changed')
      clientCompatibility.capabilities.length = 0
      return response(true)
    })
    const result = await fetchPrecomputedConfiguration({
      ...options,
      context: inputContext,
      clientCompatibility,
      fetch: requestFetch,
    })
    expect(getPrecomputedContext(result)).toEqual({ targetingKey: 'subject', nested: { tags: ['a'] } })
  })

  it.each([
    { distributionChannel: undefined },
    { distributionChannel: 'server' },
    { distributionChannel: null },
    { apiKey: 'private' },
    { clientToken: '' },
    { clientToken: undefined },
    { clientToken: 'private\r\nheader' },
    { env: '' },
    { env: undefined },
    { applicationId: '' },
    { applicationId: 'private\nheader' },
    { site: 'datadoghq.com.attacker.invalid' },
    { site: 'constructor' },
    { site: null },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 0.5 },
    { timeoutMs: Infinity },
    { timeoutMs: 2147483648 },
    { fetch: null },
    { signal: {} },
    { context: undefined },
    { context: [] },
    { context: { targetingKey: 3 } },
    { context: { value: undefined } },
    { context: { value: Infinity } },
    { context: { value: new Date() } },
    { context: { value: BigInt(1) } },
    { clientCompatibility: null },
    { clientCompatibility: {} },
    { clientCompatibility: { capabilities: 'private' } },
    { clientCompatibility: { capabilities: [3] } },
    { experimentationOptOutMode: null },
    { experimentationOptOutMode: true },
    { experimentationOptOutMode: 'invalid' },
  ])('rejects invalid options before sending a request: %p', async (override) => {
    const input = { ...options, fetch: requestFetch, ...override } as unknown as PrecomputedConfigurationFetchOptions
    await expect(fetchPrecomputedConfiguration(input)).rejects.toBeInstanceOf(ConfigurationFetchError)
    await expect(fetchPrecomputedConfiguration(input)).rejects.toMatchObject({ code: 'invalid_options' })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('sanitizes invalid context and compatibility accessors without sending', async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    for (const override of [
      { context: cycle },
      { clientCompatibility: proxy.proxy },
      {
        clientCompatibility: {
          get capabilities() {
            throw new Error('private data')
          },
        },
      },
      {
        get context() {
          throw new Error('private data')
        },
      },
    ]) {
      const input = Object.defineProperties(
        { ...options, fetch: requestFetch },
        Object.getOwnPropertyDescriptors(override)
      )
      await expect(fetchPrecomputedConfiguration(input as PrecomputedConfigurationFetchOptions)).rejects.toMatchObject({
        code: 'invalid_options',
        message: expect.not.stringContaining('private data'),
      })
    }
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('accepts future compatibility fields without reading them', async () => {
    const clientCompatibility = {
      capabilities: [capability],
      get future() {
        throw new Error('must not read unknown fields')
      },
    }
    await fetchPrecomputedConfiguration({ ...options, clientCompatibility, fetch: requestFetch })
    expect(requestFetch).toHaveBeenCalledTimes(1)
  })

  it.each([301, 302, 307, 400, 401, 429, 500])('rejects HTTP %i without exposing the body', async (status) => {
    requestFetch.mockResolvedValue(new Response('private response', { status }))
    await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'http',
      status,
      message: `Configuration fetch returned HTTP ${status}`,
    })
    expect(requestFetch).toHaveBeenCalledTimes(1)
  })

  it.each([new Response('private response', { headers: { 'Content-Type': 'text/html' } }), new Response('{}')])(
    'rejects non-JSON response media types',
    async (value) => {
      requestFetch.mockResolvedValue(value)
      await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
        code: 'invalid_response',
      })
    }
  )

  it.each(['', 'private malformed JSON', '{}', '{"data":{"attributes":{"createdAt":"now","flags":null}}}'])(
    'rejects malformed JSON or configuration without leaking it',
    async (body) => {
      requestFetch.mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
      await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
        code: 'decode',
        message: expect.not.stringContaining('private'),
      })
    }
  )

  it('rejects unsupported encoding metadata even when a known capability was advertised', async () => {
    const json = await response(true).json()
    json.data.attributes.obfuscation.scheme = 'unsupported'
    requestFetch.mockResolvedValue(
      new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
    )
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        clientCompatibility: { capabilities: [capability] },
        fetch: requestFetch,
      })
    ).rejects.toMatchObject({ code: 'decode' })
  })

  it.each(['true', 1, 'false', 0])(
    'rejects non-boolean obfuscation markers before accepting the encoding: %j',
    async (obfuscated) => {
      const json = await response(true).json()
      json.data.attributes.obfuscated = obfuscated
      requestFetch.mockResolvedValue(
        new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
      )
      await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
        code: 'decode',
      })
    }
  )

  it('sanitizes transport failures while preserving allowlisted diagnostic codes', async () => {
    requestFetch.mockRejectedValue(Object.assign(new Error('private data'), { cause: { code: 'ECONNRESET' } }))
    await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'transport',
      message: 'Configuration request failed (ECONNRESET)',
    })
  })

  it.each(['headers', 'body'])('times out during %s and removes caller listeners', async (phase) => {
    const controller = new AbortController()
    const pending = fetchPrecomputedConfiguration({
      ...options,
      timeoutMs: 25,
      signal: controller.signal,
      fetch: stalledFetch(phase),
    })
    const check = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await jest.advanceTimersByTimeAsync(25)
    await check
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['headers', 'body'])('cancels during %s without leaking the cancellation reason', async (phase) => {
    const controller = new AbortController()
    const pending = fetchPrecomputedConfiguration({ ...options, signal: controller.signal, fetch: stalledFetch(phase) })
    const check = expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'Configuration fetch cancelled' })
    await jest.advanceTimersByTimeAsync(0)
    controller.abort(new Error('private data'))
    await check
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('validates options before handling an already aborted request', async () => {
    const signal = AbortSignal.abort()
    await expect(
      fetchPrecomputedConfiguration({ ...options, signal, clientToken: '', fetch: requestFetch })
    ).rejects.toMatchObject({ code: 'invalid_options' })
    await expect(fetchPrecomputedConfiguration({ ...options, signal, fetch: requestFetch })).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('cancels an unread response body after validation fails', async () => {
    const cancel = jest.fn()
    requestFetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'text/html' } })
    )
    await expect(fetchPrecomputedConfiguration({ ...options, fetch: requestFetch })).rejects.toMatchObject({
      code: 'invalid_response',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
