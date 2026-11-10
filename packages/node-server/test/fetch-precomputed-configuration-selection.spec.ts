import { evaluate } from '@datadog/flagging-core'
import { type FlagSelection, fetchPrecomputedConfiguration } from '../src'

const payload = {
  data: {
    attributes: {
      createdAt: '2026-11-06T12:00:00Z',
      format: 'PRECOMPUTED',
      obfuscated: false,
      flags: {
        'checkout-enabled': {
          allocationKey: 'allocation',
          variationKey: 'on',
          variationType: 'boolean',
          variationValue: true,
          doLog: true,
          reason: 'TARGETING_MATCH',
          serialId: 7,
        },
      },
    },
  },
}

function response(headers: Record<string, string> = {}, body: unknown = payload): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('fetchPrecomputedConfiguration flagSelection', () => {
  const requestFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  const context = { targetingKey: 'subject' }
  const options = {
    distributionChannel: 'client' as const,
    clientToken: 'private-client-token',
    env: 'prod',
    context,
    fetch: requestFetch,
  }

  function requestedSelection() {
    return JSON.parse(requestFetch.mock.calls[0][1]!.body as string).data.attributes.flag_selection
  }

  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(console, 'error').mockImplementation(() => {})
    requestFetch.mockReset().mockImplementation(async () => response())
  })

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('sends canonical tags and key patterns in the JSON body without changing the URL or input', async () => {
    const flagSelection = Object.freeze({
      tags: Object.freeze([' team:checkout ', '\u{10000}', 'beta', '\uE000', '\u0085beta\u0085', '']),
      keyPatterns: Object.freeze([' checkout-* ', 'cart', 'checkout-*']),
    })
    await fetchPrecomputedConfiguration({ ...options, flagSelection })
    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(requestFetch.mock.calls[0][0]).toBe(
      'https://preview.ff-cdn.datadoghq.com/precompute-assignments?dd_env=prod'
    )
    expect(requestedSelection()).toEqual({
      tags: ['beta', 'team:checkout', '\uE000', '\u{10000}'],
      key_patterns: ['cart', 'checkout-*'],
    })
    expect(requestFetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'dd-client-token': options.clientToken },
    })
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each(['tags', 'keyPatterns'] as const)('allows %s independently', async (field) => {
    await fetchPrecomputedConfiguration({ ...options, flagSelection: { [field]: ['checkout'] } })
    expect(requestedSelection()).toEqual({
      tags: field === 'tags' ? ['checkout'] : [],
      key_patterns: field === 'keyPatterns' ? ['checkout'] : [],
    })
  })

  it('accepts 31 distinct 200-byte values per list without applying the rules-fetch URL limit', async () => {
    const values = Array.from({ length: 31 }, (_, index) => `${index}`.padStart(2, '0') + '\u00e9'.repeat(99))
    const withDuplicates = [...values, ` ${values[0]} `, '']
    await fetchPrecomputedConfiguration({
      ...options,
      flagSelection: { tags: withDuplicates, keyPatterns: withDuplicates },
    })
    expect(requestedSelection()).toEqual({ tags: values, key_patterns: values })
    expect(Buffer.byteLength(requestFetch.mock.calls[0][1]!.body as string)).toBeGreaterThan(8192)
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}, { tags: [], keyPatterns: [] }, { tags: [' ', '\u0085'], keyPatterns: [''] }])(
    'omits empty selection %j without diagnostics',
    async (flagSelection) => {
      const result = response({ 'DD-Flag-Selection-Ignored': 'tag_load_failed' })
      const getHeader = jest.spyOn(result.headers, 'get')
      requestFetch.mockResolvedValue(result)
      await fetchPrecomputedConfiguration({ ...options, flagSelection: flagSelection as FlagSelection })
      expect(requestedSelection()).toBeUndefined()
      expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
      expect(console.error).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['non-object', 'checkout', 'malformed_selection'],
    ['non-array tags', { tags: 'checkout', keyPatterns: ['cart-*'] }, 'malformed_selection'],
    ['sparse patterns', { tags: ['checkout'], keyPatterns: Array(1) }, 'malformed_selection'],
    ['unpaired surrogate', { keyPatterns: ['\uD800'] }, 'malformed_selection'],
    ['too many tags', { tags: Array.from({ length: 32 }, (_, i) => `tag-${i}`) }, 'too_many_values'],
    ['too many patterns', { keyPatterns: Array.from({ length: 32 }, (_, i) => `key-${i}`) }, 'too_many_values'],
    ['long tag', { tags: ['private-tag'.repeat(21)], keyPatterns: ['cart-*'] }, 'invalid_tag'],
    ['long multibyte pattern', { tags: ['checkout'], keyPatterns: ['\u00e9'.repeat(101)] }, 'invalid_key_pattern'],
  ])('drops the entire selection for %s and reports only the reason', async (_, flagSelection, reason) => {
    const result = response({ 'DD-Flag-Selection-Ignored': 'tag_load_failed' })
    const getHeader = jest.spyOn(result.headers, 'get')
    requestFetch.mockResolvedValue(result)
    const configuration = await fetchPrecomputedConfiguration({
      ...options,
      flagSelection: flagSelection as FlagSelection,
    })
    expect(configuration.precomputed?.response).toEqual(payload)
    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(requestedSelection()).toBeUndefined()
    expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
    expect(console.error).toHaveBeenCalledTimes(1)
    const message = jest.mocked(console.error).mock.calls[0][0] as string
    expect(message).toContain(`flagSelection was not sent (${reason}:`)
    expect(message).not.toMatch(/private|checkout|cart/)
  })

  it.each(['getter', 'proxy'])('drops a throwing %s without exposing its error', async (kind) => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const flagSelection =
      kind === 'proxy'
        ? proxy
        : {
            get tags(): string[] {
              throw new Error('private-selection')
            },
          }
    await expect(fetchPrecomputedConfiguration({ ...options, flagSelection })).resolves.toHaveProperty('precomputed')
    expect(requestedSelection()).toBeUndefined()
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('malformed_selection'))
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('private-selection'))
  })

  it.each([undefined, '', 'tag_load_failed', 'future_reason'])(
    'handles ignored-selection header %j without locally filtering',
    async (reason) => {
      requestFetch.mockResolvedValue(response(reason === undefined ? {} : { 'DD-Flag-Selection-Ignored': reason }))
      const configuration = await fetchPrecomputedConfiguration({
        ...options,
        flagSelection: { keyPatterns: ['non-matching-*'] },
      })
      expect(configuration.precomputed?.response).toEqual(payload)
      expect(evaluate(configuration, 'boolean', 'checkout-enabled', false, context)).toMatchObject({
        value: true,
        variant: 'on',
      })
      if (reason) {
        expect(console.error).toHaveBeenCalledTimes(1)
        expect(console.error).toHaveBeenCalledWith(
          `flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`
        )
      } else expect(console.error).not.toHaveBeenCalled()
    }
  )

  it('preserves an empty selected response and returns the evaluation default for absent flags', async () => {
    requestFetch.mockResolvedValue(response({}, { data: { attributes: { ...payload.data.attributes, flags: {} } } }))
    const configuration = await fetchPrecomputedConfiguration({ ...options, flagSelection: { tags: ['no-match'] } })
    expect(configuration.precomputed?.response.data.attributes.flags).toEqual({})
    expect(evaluate(configuration, 'boolean', 'checkout-enabled', false, context)).toMatchObject({
      value: false,
      errorCode: 'FLAG_NOT_FOUND',
    })
  })

  it.each(['dropped', 'ignored'])('uses a custom logger and tolerates its errors for a %s selection', async (kind) => {
    const logger = {
      error: jest.fn(() => {
        throw new Error('logger failure')
      }),
    }
    requestFetch.mockResolvedValue(response({ 'DD-Flag-Selection-Ignored': 'tag_load_failed' }))
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        flagSelection: { tags: [kind === 'dropped' ? 'x'.repeat(201) : 'checkout'] },
        logger,
      })
    ).resolves.toHaveProperty('precomputed')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(console.error).not.toHaveBeenCalled()
  })

  it.each([null, {}, { error: true }])('rejects invalid logger %j before fetching', async (logger) => {
    await expect(fetchPrecomputedConfiguration({ ...options, logger: logger as never })).rejects.toMatchObject({
      code: 'invalid_options',
    })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('retains cancellation after dropping an invalid selection', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchPrecomputedConfiguration({
        ...options,
        signal: controller.signal,
        flagSelection: { tags: ['x'.repeat(201)] },
      })
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('reports ignored selection before a decode failure, without replacing the error', async () => {
    requestFetch.mockResolvedValue(
      new Response('invalid-json', {
        headers: {
          'Content-Type': 'application/json',
          'DD-Flag-Selection-Ignored': 'tag_load_failed',
        },
      })
    )
    await expect(
      fetchPrecomputedConfiguration({ ...options, flagSelection: { tags: ['checkout'] } })
    ).rejects.toMatchObject({ code: 'decode' })
    expect(console.error).toHaveBeenCalledTimes(1)
  })

  it('does not treat an HTTP error as an ignored-selection success', async () => {
    const failed = new Response('', { status: 403, headers: { 'DD-Flag-Selection-Ignored': 'tag_load_failed' } })
    const getHeader = jest.spyOn(failed.headers, 'get')
    requestFetch.mockResolvedValue(failed)
    await expect(
      fetchPrecomputedConfiguration({ ...options, flagSelection: { tags: ['checkout'] } })
    ).rejects.toMatchObject({ code: 'http', status: 403 })
    expect(getHeader).not.toHaveBeenCalledWith('DD-Flag-Selection-Ignored')
    expect(console.error).not.toHaveBeenCalled()
  })
})
