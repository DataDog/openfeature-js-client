import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import wire from '../../browser/test/data/rules-v1-wire.json'
import { ConfigurationFetchError, type FlagSelection, fetchRulesConfiguration } from '../src/rules-based'

const body = Buffer.from(wire.rules.response, 'base64')
const headers = { 'Content-Type': 'application/protobuf', ETag: wire.rules.etag }

function unstableSelection(nextValue: unknown): FlagSelection {
  let reads = 0
  const keyPatterns = ['valid']
  Object.defineProperty(keyPatterns, 0, { get: () => (reads++ === 0 ? 'valid' : nextValue) })
  return { keyPatterns }
}

describe.each([
  { distributionChannel: 'server', apiKey: 'server-key' },
  { distributionChannel: 'client', clientToken: 'client-token' },
] as const)('fetchRulesConfiguration flagSelection ($distributionChannel)', (credentials) => {
  const requestFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
  const options = { ...credentials, env: 'prod', fetch: requestFetch }
  const baseUrl = `https://ufc-${credentials.distributionChannel}.ff-cdn.datadoghq.com/api/v2/feature-flagging/config/rules-based/${credentials.distributionChannel}?dd_env=prod`

  beforeEach(() => {
    jest.useFakeTimers()
    requestFetch.mockReset().mockImplementation(async () => new Response(Uint8Array.from(body), { headers }))
  })

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('canonicalizes both lists without mutating them or changing authentication', async () => {
    const flagSelection = Object.freeze({
      tags: Object.freeze([' team:web ', '\u{10000}', 'beta', '\uE000', '\u0085beta\u0085', '']),
      keyPatterns: Object.freeze([' ffe-* ', 'checkout', 'ffe-*']),
    })
    await fetchRulesConfiguration({ ...options, env: 'test & preview', flagSelection })
    await fetchRulesConfiguration({
      ...options,
      env: 'test & preview',
      flagSelection: { tags: ['\uE000', 'team:web', 'beta', '\u{10000}'], keyPatterns: ['checkout', 'ffe-*'] },
    })

    expect(requestFetch).toHaveBeenCalledTimes(2)
    expect(requestFetch.mock.calls[0][0]).toBe(
      baseUrl.replace('dd_env=prod', 'dd_env=test+%26+preview') +
        '&selected_flag_tags=beta&selected_flag_tags=team%3Aweb' +
        '&selected_flag_tags=%EE%80%80&selected_flag_tags=%F0%90%80%80' +
        '&selected_flag_key_patterns=checkout&selected_flag_key_patterns=ffe-%2A'
    )
    expect(requestFetch.mock.calls[1][0]).toBe(requestFetch.mock.calls[0][0])
    expect(requestFetch.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/protobuf',
        'DD-Client-Library-Language': 'nodejs',
        'DD-Client-Library-Version': '1.0.0-test',
        ...(credentials.distributionChannel === 'client'
          ? { 'dd-client-token': credentials.clientToken }
          : { 'dd-api-key': credentials.apiKey }),
      },
    })
  })

  it.each([
    ['ffe-*', 'ffe-%2A'],
    ['a b', 'a%20b'],
    ["(x)!'", '%28x%29%21%27'],
    ['~a-b_c.d', '~a-b_c.d'],
    ['\u00e9', '%C3%A9'],
    ['a&b=c+#%', 'a%26b%3Dc%2B%23%25'],
  ])('RFC 3986 encodes %j in both lists', async (value, encoded) => {
    await fetchRulesConfiguration({ ...options, flagSelection: { tags: [value], keyPatterns: [value] } })
    expect(requestFetch.mock.calls[0][0]).toBe(
      `${baseUrl}&selected_flag_tags=${encoded}&selected_flag_key_patterns=${encoded}`
    )
  })

  it.each([undefined, null, {}, { tags: [], keyPatterns: [] }, { tags: [' ', '\u0085'], keyPatterns: [''] }])(
    'leaves the request unchanged for empty selection %j',
    async (flagSelection) => {
      await fetchRulesConfiguration({ ...options, flagSelection: flagSelection as FlagSelection })
      expect(requestFetch).toHaveBeenCalledTimes(1)
      expect(requestFetch.mock.calls[0][0]).toBe(baseUrl)
    }
  )

  it.each([
    ['non-object', 'checkout', 'malformed_selection'],
    ['array', [], 'malformed_selection'],
    ['non-array tags', { tags: 'checkout', keyPatterns: ['ffe-*'] }, 'malformed_selection'],
    ['non-string pattern', { tags: ['checkout'], keyPatterns: [1] }, 'malformed_selection'],
    ['sparse list', { tags: Array(1), keyPatterns: ['ffe-*'] }, 'malformed_selection'],
    ['unpaired surrogate', { tags: ['checkout'], keyPatterns: ['\uD800'] }, 'malformed_selection'],
    [
      'too many tags',
      { tags: Array.from({ length: 32 }, (_, index) => `tag-${index}`), keyPatterns: ['ffe-*'] },
      'too_many_values',
    ],
    [
      'too many patterns',
      { tags: ['checkout'], keyPatterns: Array.from({ length: 32 }, (_, index) => `flag-${index}`) },
      'too_many_values',
    ],
    ['long tag', { tags: ['t'.repeat(201)], keyPatterns: ['ffe-*'] }, 'invalid_tag'],
    ['long pattern', { tags: ['checkout'], keyPatterns: ['k'.repeat(201)] }, 'invalid_key_pattern'],
    ['multibyte tag', { tags: ['\u00e9'.repeat(101)], keyPatterns: ['ffe-*'] }, 'invalid_tag'],
    ['multibyte pattern', { tags: ['checkout'], keyPatterns: ['\u00e9'.repeat(101)] }, 'invalid_key_pattern'],
  ])('rejects %s before fetching', async (_, flagSelection, reason) => {
    const pending = fetchRulesConfiguration({ ...options, flagSelection: flagSelection as FlagSelection })
    await expect(pending).rejects.toBeInstanceOf(ConfigurationFetchError)
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_options',
      message: `Invalid configuration fetch options: flagSelection (${reason})`,
    })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'throwing getter',
      createSelection: () => ({
        get tags(): string[] {
          throw new Error('secret selection data')
        },
      }),
    },
    {
      name: 'getter throwing a ConfigurationFetchError',
      createSelection: () => ({
        get tags(): string[] {
          throw new ConfigurationFetchError('http', 'secret selection data', 403)
        },
      }),
    },
    {
      name: 'revoked proxy',
      createSelection: () => {
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()
        return proxy
      },
    },
    { name: 'element changing to a non-string', createSelection: () => unstableSelection(null) },
    { name: 'element changing to a lone surrogate', createSelection: () => unstableSelection('\uD800') },
  ])('sanitizes a $name before fetching', async ({ createSelection }) => {
    const pending = fetchRulesConfiguration({ ...options, flagSelection: createSelection() })
    await expect(pending).rejects.toBeInstanceOf(ConfigurationFetchError)
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_options',
      message: 'Invalid configuration fetch options: flagSelection',
    })
    await expect(pending).rejects.not.toHaveProperty('cause')
    await expect(pending).rejects.toHaveProperty('status', undefined)
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('validates selection before checking caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchRulesConfiguration({ ...options, signal: controller.signal, flagSelection: { tags: ['t'.repeat(201)] } })
    ).rejects.toMatchObject({ code: 'invalid_options' })
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['tags', 'selected_flag_tags'],
    ['keyPatterns', 'selected_flag_key_patterns'],
  ] as const)('accepts 31 distinct %s with 200-byte values after canonicalization', async (field, queryParam) => {
    const values = Array.from({ length: 31 }, (_, index) => `${index}`.padEnd(200, 'a'))
    await fetchRulesConfiguration({ ...options, flagSelection: { [field]: [...values, ` ${values[0]} `, ''] } })
    const url = new URL(requestFetch.mock.calls[0][0] as string)
    expect(url.searchParams.getAll(queryParam)).toEqual([...values].sort())
  })

  it('accepts a value at the UTF-8 byte limit', async () => {
    const value = '\u00e9'.repeat(100)
    await fetchRulesConfiguration({ ...options, flagSelection: { tags: [value], keyPatterns: [value] } })
    const url = new URL(requestFetch.mock.calls[0][0] as string)
    expect(url.searchParams.getAll('selected_flag_tags')).toEqual([value])
    expect(url.searchParams.getAll('selected_flag_key_patterns')).toEqual([value])
  })

  it.each([8192, 8193])('enforces the URL limit at %i bytes', async (urlBytes) => {
    const keyPatterns = Array.from({ length: 31 }, (_, index) => `${index}`.padEnd(200, 'k'))
    const patternsLength = keyPatterns.reduce(
      (total, pattern) => total + '&selected_flag_key_patterns='.length + pattern.length,
      0
    )
    const tagRoom = urlBytes - baseUrl.length - patternsLength
    const tagCount = Math.ceil(tagRoom / 200)
    const tagValueBytes = tagRoom - tagCount * '&selected_flag_tags='.length
    const tags = Array.from({ length: tagCount }, (_, index) =>
      `${index}`.padEnd(Math.floor(tagValueBytes / tagCount) + (index < tagValueBytes % tagCount ? 1 : 0), 't')
    )
    const result = await fetchRulesConfiguration({ ...options, flagSelection: { tags, keyPatterns } })
    expect(result.rules).toBeDefined()
    expect(requestFetch).toHaveBeenCalledTimes(1)
    if (urlBytes === 8192) {
      const url = new URL(requestFetch.mock.calls[0][0] as string)
      expect(Buffer.byteLength(url.toString())).toBe(8192)
      expect(url.searchParams.getAll('selected_flag_tags')).toHaveLength(tags.length)
      expect(url.searchParams.getAll('selected_flag_key_patterns')).toHaveLength(keyPatterns.length)
    } else {
      expect(requestFetch.mock.calls[0][0]).toBe(baseUrl)
    }
  })

  it('checks the URL size after percent-encoding', async () => {
    const keyPatterns = Array.from({ length: 31 }, (_, index) => `${index}`.padEnd(200, '*'))
    await fetchRulesConfiguration({ ...options, flagSelection: { keyPatterns } })
    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(requestFetch.mock.calls[0][0]).toBe(baseUrl)
  })

  it.each([undefined, 'invalid_key_pattern'])('accepts unfiltered responses with ignored reason %j', async (reason) => {
    const responseHeaders = new Headers(headers)
    if (reason) responseHeaders.set('DD-Flag-Selection-Ignored', reason)
    requestFetch.mockResolvedValue(new Response(Uint8Array.from(body), { headers: responseHeaders }))
    const result = await fetchRulesConfiguration({ ...options, flagSelection: { keyPatterns: ['non-matching-*'] } })
    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(requestFetch.mock.calls[0][0]).toBe(`${baseUrl}&selected_flag_key_patterns=non-matching-%2A`)
    expect(result.rules).toMatchObject({
      response: configurationFromRulesBinary(body).rules!.response,
      etag: wire.rules.etag,
      fetchedAt: Date.now(),
    })
  })
})
