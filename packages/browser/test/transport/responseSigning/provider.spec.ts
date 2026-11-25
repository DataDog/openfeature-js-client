import { createHash, sign, webcrypto } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import { TextDecoder, TextEncoder } from 'node:util'
import { display } from '@datadog/browser-core'
import { evaluatePrecomputedConfiguration, parsePrecomputedConfigurationResponse } from '@datadog/flagging-core'
import { ErrorCode, OpenFeature, ProviderEvents, ProviderStatus, StandardResolutionReasons } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../../src/domain/configuration'
import { DatadogProvider } from '../../../src/openfeature/provider'
import {
  createFlagsConfigurationFetcher,
  fetchPrecomputedConfiguration,
} from '../../../src/transport/fetchConfiguration'
import {
  createResponseSigningController,
  signingContextKey,
  UNSUPPORTED_SITE_MESSAGE,
} from '../../../src/transport/responseSigning/controller'
import { isSigningSite } from '../../../src/transport/responseSigning/trustRoots'
import {
  buildSigningTranscript,
  decodeBase64,
  MAX_SIGNED_RESPONSE,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION_HEADER,
  signingFailureMessage,
} from '../../../src/transport/responseSigning/verification'
import { FIXTURE_NOW, loadCredential, ROOT_A } from './chainFixtures'

// Test-CA-issued credential: root A -> upper intermediate -> lower intermediate -> leaf.
const credential = loadCredential('two-intermediates')
const vector = { now: FIXTURE_NOW }
const roots = [ROOT_A]
const context = { targetingKey: 'user-123', nested: { plan: 'team' } }
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const payload = (value = true) => ({
  data: {
    attributes: {
      createdAt: '2026-10-27T09:00:00Z',
      flags: {
        critical: {
          allocationKey: 'allocation',
          variationKey: 'on',
          variationType: 'boolean',
          variationValue: value,
          reason: 'TARGETING_MATCH',
          doLog: false,
        },
      },
    },
  },
})
// Response signing is available only on the staging site.
const STAGING = { site: 'datad0g.com' }
const defaultOptions: FlaggingInitConfiguration = {
  site: 'datad0g.com',
  clientToken: 'token-a',
  env: 'production',
  applicationId: 'app-a',
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
const previousFetch = global.fetch
const providers: DatadogProvider[] = []
function bytes(value: ArrayBuffer | ArrayBufferView): Buffer<ArrayBuffer> {
  return ArrayBuffer.isView(value)
    ? Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    : Buffer.from(new Uint8Array(value))
}
// Adapt only jsdom's foreign-realm buffers; all digest/key/signature operations use native WebCrypto.
const cryptoBridge = {
  getRandomValues: (array: Uint8Array) => {
    array.set(webcrypto.getRandomValues(Buffer.alloc(array.length)))
    return array
  },
  subtle: {
    digest: (algorithm: AlgorithmIdentifier, data: ArrayBuffer) => webcrypto.subtle.digest(algorithm, bytes(data)),
    importKey: (
      format: 'raw',
      data: ArrayBuffer,
      algorithm: EcKeyImportParams,
      extractable: boolean,
      usages: KeyUsage[]
    ) => webcrypto.subtle.importKey(format, bytes(data), algorithm, extractable, usages),
    verify: (algorithm: EcdsaParams, key: CryptoKey, signature: ArrayBuffer, data: ArrayBuffer) =>
      webcrypto.subtle.verify(algorithm, key, bytes(signature), bytes(data)),
  },
}
beforeEach(() => {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoBridge })
  jest.spyOn(Date, 'now').mockReturnValue(vector.now * 1000)
})
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.onClose()
  Object.defineProperty(globalThis, 'crypto', previousCrypto)
  global.fetch = previousFetch
  jest.restoreAllMocks()
})
function provider(mode: 'off' | 'observe' | 'required', extra: Partial<FlaggingInitConfiguration> = {}) {
  const result = new DatadogProvider({
    ...defaultOptions,
    experimentalResponseSigning: { mode, trustedRootCertificates: roots },
    ...extra,
  })
  providers.push(result)
  return result
}
/** expireVerifiedFlags: true keeps the strict behavior: ERROR and defaults at proof expiry. */
const strict = () => ({
  experimentalResponseSigning: { mode: 'required' as const, trustedRootCertificates: roots, expireVerifiedFlags: true },
})
/**
 * Assignment requests only (not telemetry). Flag-evaluation telemetry batches also use global.fetch, on a real timer that can fire
 * in any test (more often on a slow CI runner), so a raw global.fetch call count is not deterministic.
 */
function assignmentRequests() {
  // Telemetry goes to the /api/v2/ intake routes; assignments go to the endpoint or a proxy.
  return (global.fetch as jest.Mock).mock.calls.filter(([url]) => !new URL(String(url)).pathname.startsWith('/api/v2/'))
}
function response(body: string, headers: Headers = new Headers(), status = 200): Response {
  // Transport boundary: exact bytes, ordinary parser, status and headers; no verifier is mocked.
  const buffer = new TextEncoder().encode(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'error',
    headers,
    redirected: false,
    body: null,
    arrayBuffer: async () => buffer.buffer,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as Response
}
function unsigned(value = true) {
  return response(JSON.stringify(payload(value)))
}
async function signed(
  url: RequestInfo | URL,
  init: RequestInit = {},
  value = true,
  issuedAt = vector.now,
  rawBody = JSON.stringify(payload(value))
): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-datadog-feature-flags-signature-version': '1',
    'x-datadog-feature-flags-signing-certificate': credential.leafBase64,
    'x-datadog-feature-flags-signing-chain': credential.intermediatesBase64.join(','),
    'x-datadog-feature-flags-certificate-id': createHash('sha256')
      .update(Buffer.from(credential.leafBase64, 'base64'))
      .digest('hex'),
  })
  headers.set('x-datadog-feature-flags-issued-at', String(issuedAt))
  headers.set('x-datadog-feature-flags-expires-at', String(issuedAt + 300))
  const body = new TextEncoder().encode(rawBody)
  const request = {
    url: String(url),
    method: 'POST',
    headers: new Headers(init.headers),
    body: new TextEncoder().encode(init.body as string),
  }
  const transcript = await buildSigningTranscript(
    request,
    { status: 200, headers, body },
    issuedAt,
    issuedAt + 300,
    decodeBase64(headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
    credential.intermediatesBase64.map((value) => decodeBase64(value, 4096))
  )
  headers.set(
    'x-datadog-feature-flags-signature',
    sign('sha256', Buffer.from(transcript), credential.privateKey).toString('base64')
  )
  return response(new TextDecoder().decode(body), headers)
}
function evaluation(subject: DatadogProvider) {
  return subject.resolveBooleanEvaluation('critical', false, {}, logger).value
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 60))

test('off preserves ordinary headers/redirect behavior and performs no crypto', async () => {
  const random = jest.spyOn(cryptoBridge, 'getRandomValues')
  const digest = jest.spyOn(cryptoBridge.subtle, 'digest')
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  await fetchPrecomputedConfiguration({ ...defaultOptions, env: 'production', context })
  expect(random).not.toHaveBeenCalled()
  expect(digest).not.toHaveBeenCalled()
  const subject = provider('off')
  await subject.initialize(context)
  const init = (global.fetch as jest.Mock).mock.calls[0][1]
  expect(new Headers(init.headers).get(SIGNING_VERSION_HEADER)).toBeNull()
  expect(new Headers(init.headers).get('x-stream')).toBeNull()
  expect(init.redirect).toBeUndefined()
  // Provider construction retains its existing tracking UUID generation.
  expect(digest).not.toHaveBeenCalled()
  expect(evaluation(subject)).toBe(true)
})
test('required needs a local anchor for a destination without a bundled root, before any network operation', () => {
  global.fetch = jest.fn()
  expect(() =>
    provider('required', {
      flaggingProxy: 'https://proxy.test/assign',
      experimentalResponseSigning: { mode: 'required' },
    })
  ).toThrow('Flag response signing failed (missing-anchor)')
  expect(assignmentRequests()).toHaveLength(0)
})
test('staging selects its root only when signing is enabled', () => {
  expect(createResponseSigningController(undefined, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'off' }, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })).toBeDefined()
  expect(() =>
    createResponseSigningController({ mode: 'required', trustedRootCertificates: [] }, { site: 'datad0g.com' })
  ).toThrow('Flag response signing failed (missing-anchor)')
})
test.each([
  'https://preview.ff-cdn.datadoghq.com/precompute-assignments',
  'https://preview.ff-cdn.datad0g.com.attacker.test/precompute-assignments',
  'https://attacker-preview.ff-cdn.datad0g.com/precompute-assignments',
  'https://preview.ff-cdn.datad0g.com:444/precompute-assignments',
  'http://preview.ff-cdn.datad0g.com/precompute-assignments',
  'https://user@preview.ff-cdn.datad0g.com/precompute-assignments',
  'https://proxy.test/assign',
])('staging site cannot enroll a different destination: %s', (flaggingProxy) => {
  expect(() =>
    provider('required', {
      site: 'datad0g.com',
      flaggingProxy,
      experimentalResponseSigning: { mode: 'required' },
    })
  ).toThrow('Flag response signing failed (missing-anchor)')
})
test.each(['DATAD0G.COM', 'Datad0g.com', 'datad0g.com.', 'evil-datad0g.com', 'datad0g.com.evil.test', ' datad0g.com'])(
  'the lookalike site %j is not the signing site',
  (site) => {
    expect(isSigningSite(site)).toBe(false)
    // The endpoint builder also rejects the site, so no signed request can be made.
    jest.spyOn(display, 'error').mockImplementation(() => undefined)
    expect(() => createResponseSigningController({ mode: 'required' }, { site })).toThrow('Unsupported site')
  }
)
test('automatic trust cannot be reused for a different request origin', async () => {
  const signing = createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })!
  const headers = { 'dd-client-token': 'pub0123456789abcdef0123456789abcdef' }
  // Control: the same headers sign a request to the bundled origin.
  await expect(
    signing.prepare('https://preview.ff-cdn.datad0g.com/precompute-assignments', headers, '{}')
  ).resolves.toBeDefined()
  await expect(signing.prepare('https://proxy.test/assign', headers, '{}')).rejects.toThrow('unsupported-request')
})
test.each(['provider', 'fetch', 'factory'] as const)(
  '%s selects staging trust from the resolved endpoint without another option',
  async (entry) => {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    const options = {
      ...defaultOptions,
      site: 'datad0g.com' as const,
      env: 'staging',
      experimentalResponseSigning: { mode: 'observe' as const },
    }
    if (entry === 'provider') await provider('observe', options).initialize(context)
    else if (entry === 'factory') await createFlagsConfigurationFetcher(options)(context)
    else await fetchPrecomputedConfiguration({ ...options, context })
    expect(assignmentRequests()).toHaveLength(1)
    expect(new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers).get(SIGNING_VERSION_HEADER)).toBe('1')
  }
)
describe('staging site gate', () => {
  // Every site except datad0g.com, including the default site and a production site behind a staging proxy.
  const sites: Array<[string, Partial<FlaggingInitConfiguration>]> = [
    ['default site', { site: undefined }],
    ['datadoghq.com', { site: 'datadoghq.com' }],
    ['datadoghq.eu', { site: 'datadoghq.eu' }],
    ['us3.datadoghq.com', { site: 'us3.datadoghq.com' }],
    [
      'datadoghq.com behind a staging proxy',
      { site: 'datadoghq.com', flaggingProxy: 'https://preview.ff-cdn.datad0g.com/precompute-assignments' },
    ],
  ]
  const entries = ['provider', 'fetch', 'factory'] as const
  const cases = entries.flatMap((entry) =>
    sites.flatMap(([label, site]) => (['observe'] as const).map((mode) => [entry, label, site, mode] as const))
  )
  async function send(
    entry: (typeof entries)[number],
    options: FlaggingInitConfiguration
  ): Promise<{ url: unknown; init: RequestInit }> {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    if (entry === 'provider') {
      const subject = new DatadogProvider(options)
      providers.push(subject)
      await subject.initialize(context)
      expect(evaluation(subject)).toBe(true)
    } else if (entry === 'factory') await createFlagsConfigurationFetcher(options)(context)
    else await fetchPrecomputedConfiguration({ ...options, env: options.env ?? '', context })
    expect(assignmentRequests()).toHaveLength(1)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    return { url, init }
  }
  test.each(cases)('%s on %s: %s opt-in is a no-op with a warning', async (entry, _label, site, mode) => {
    const warn = jest.spyOn(display, 'warn').mockImplementation(() => undefined)
    const random = jest.spyOn(cryptoBridge, 'getRandomValues')
    const ordinary = await send(entry, { ...defaultOptions, ...site })
    expect(warn).not.toHaveBeenCalled()
    const ordinaryRandomCalls = random.mock.calls.length
    random.mockClear()
    // An unsigned response is accepted in both modes, exactly as without opt-in.
    const optedIn = await send(entry, {
      ...defaultOptions,
      ...site,
      experimentalResponseSigning: { mode, trustedRootCertificates: roots },
    })
    expect(optedIn.url).toBe(ordinary.url)
    // AbortSignal instances and the per-provider diagnostics instance ID differ; every other field is equal.
    const instance = (body: unknown) => String(body).replace(/"instance_id":"[^"]*"/, '"instance_id":""')
    const { signal: optedInSignal, ...optedInRest } = optedIn.init
    const { signal: ordinarySignal, ...ordinaryRest } = ordinary.init
    expect({ ...optedInRest, body: instance(optedInRest.body) }).toEqual({
      ...ordinaryRest,
      body: instance(ordinaryRest.body),
    })
    expect(typeof optedInSignal).toBe(typeof ordinarySignal)
    expect(Object.keys(optedIn.init).sort()).toEqual(Object.keys(ordinary.init).sort())
    const headers = new Headers(optedIn.init.headers)
    expect(headers.get(SIGNING_VERSION_HEADER)).toBeNull()
    expect(headers.get(SIGNING_NONCE_HEADER)).toBeNull()
    expect(headers.get('x-stream')).toBeNull()
    expect(headers.get('x-dd-feature-flags-capabilities') ?? '').not.toContain('response-signing-v1')
    expect(optedIn.init.redirect).toBeUndefined()
    // No nonce is generated: only the ordinary provider instance ID uses randomness.
    expect(random).toHaveBeenCalledTimes(ordinaryRandomCalls)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'Flag response signing failed (unsupported-site): Signing is not available on this Datadog site. ' +
        'Response signing supports only the staging site in this release. Production is not supported yet. ' +
        'The staging site is datad0g.com. Flags are not verified, and requests are sent without signing.'
    )
  })
  const requiredCases = entries.flatMap((entry) => sites.map(([label, site]) => [entry, label, site] as const))
  test.each(requiredCases)('%s on %s: required fails closed and sends no request', async (entry, _label, site) => {
    const warn = jest.spyOn(display, 'warn').mockImplementation(() => undefined)
    const error = jest.spyOn(display, 'error').mockImplementation(() => undefined)
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    const options = {
      ...defaultOptions,
      ...site,
      initialFlagsConfiguration: undefined,
      experimentalResponseSigning: { mode: 'required' as const, trustedRootCertificates: roots },
    }
    const attempts: Array<() => Promise<unknown>> = []
    let subject: DatadogProvider | undefined
    if (entry === 'provider') {
      subject = new DatadogProvider(options)
      providers.push(subject)
      const provider = subject
      attempts.push(
        () => provider.initialize(context),
        () => provider.onContextChange(context, { ...context, targetingKey: 'user-456' })
      )
    } else if (entry === 'factory') {
      const fetcher = createFlagsConfigurationFetcher(options)
      attempts.push(
        () => fetcher(context),
        () => fetcher(context)
      )
    } else attempts.push(...[0, 1].map(() => () => fetchPrecomputedConfiguration({ ...options, env: '', context })))
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow(UNSUPPORTED_SITE_MESSAGE)
    expect(assignmentRequests()).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    // One error per controller: the provider and factory build one at init, the standalone fetch one per call.
    expect(error).toHaveBeenCalledTimes(entry === 'fetch' ? 2 : 1)
    expect(error).toHaveBeenCalledWith(UNSUPPORTED_SITE_MESSAGE)
    if (subject) {
      expect(subject.status).toBe(ProviderStatus.ERROR)
      expect(subject.resolveBooleanEvaluation('critical', true, {}, logger)).toMatchObject({
        value: true,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.GENERAL,
        errorMessage: UNSUPPORTED_SITE_MESSAGE,
      })
    }
  })
  test('the unsupported-site error says staging only and how to fix it', () => {
    expect(UNSUPPORTED_SITE_MESSAGE).toBe(
      'Flag response signing failed (unsupported-site): Signing is not available on this Datadog site. ' +
        'Response signing supports only the staging site in this release. Production is not supported yet. ' +
        "The staging site is datad0g.com. Remove experimentalResponseSigning mode 'required', or use 'observe'."
    )
  })
  test.each(['observe', 'required'] as const)(
    'a non-staging site does not read or validate signing trust options in %s mode',
    async (mode) => {
      const read = jest.fn(() => ['x'.repeat(6000)])
      jest.spyOn(display, 'warn').mockImplementation(() => undefined)
      jest.spyOn(display, 'error').mockImplementation(() => undefined)
      const controller = createResponseSigningController(
        {
          mode,
          get trustedRootCertificates(): readonly string[] {
            return read()
          },
        },
        { site: 'datadoghq.com' }
      )
      if (mode === 'observe') expect(controller).toBeUndefined()
      else await expect(controller?.prepare('https://example.test', {}, '{}')).rejects.toThrow(UNSUPPORTED_SITE_MESSAGE)
      expect(read).not.toHaveBeenCalled()
    }
  )
  test('invalid ordinary configuration with required mode on a non-staging site is not a signing error', () => {
    jest.spyOn(display, 'warn').mockImplementation(() => undefined)
    jest.spyOn(display, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(
      () =>
        new DatadogProvider({
          ...defaultOptions,
          site: 'datadoghq.com',
          clientToken: '',
          experimentalResponseSigning: { mode: 'required' },
        })
    ).not.toThrow('Required response signing')
  })
  test('required mode ignores bootstrap data when the ordinary configuration is invalid on a non-staging site', () => {
    jest.spyOn(display, 'warn').mockImplementation(() => undefined)
    jest.spyOn(display, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const subject = new DatadogProvider({
      ...defaultOptions,
      site: 'datadoghq.com',
      clientToken: '',
      experimentalResponseSigning: { mode: 'required' },
      initialFlagsConfiguration: { precomputed: { response: payload(), context: {}, fetchedAt: 1 as any } } as any,
    })
    expect(evaluation(subject)).toBe(false)
  })
  test.each(entries.flatMap((entry) => (['observe', 'required'] as const).map((mode) => [entry, mode] as const)))(
    '%s on the staging site in %s mode never sends X-stream',
    async (entry, mode) => {
      const { init } = await send(entry, {
        ...defaultOptions,
        experimentalResponseSigning: { mode, trustedRootCertificates: roots },
      }).catch(() => ({ init: (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit }))
      const headers = new Headers(init.headers)
      expect(headers.get(SIGNING_VERSION_HEADER)).toBe('1')
      expect(headers.has('x-stream')).toBe(false)
      expect(Object.keys(init.headers ?? {}).some((key) => key.toLowerCase() === 'x-stream')).toBe(false)
    }
  )
  test.each(entries.flatMap((entry) => (['observe', 'required'] as const).map((mode) => [entry, mode] as const)))(
    '%s: the old responseSigning key in %s mode has no effect',
    async (entry, mode) => {
      const { init } = await send(entry, {
        ...defaultOptions,
        // No alias: the experimental option is the only signing opt-in.
        ...({ responseSigning: { mode, trustedRootCertificates: roots } } as unknown as FlaggingInitConfiguration),
      })
      const headers = new Headers(init.headers)
      expect(headers.get(SIGNING_VERSION_HEADER)).toBeNull()
      expect(headers.get(SIGNING_NONCE_HEADER)).toBeNull()
      expect(headers.get('x-dd-feature-flags-capabilities') ?? '').not.toContain('response-signing-v1')
      expect(init.redirect).toBeUndefined()
    }
  )
  test('the staging site sends the opt-in request headers', async () => {
    const { url, init } = await send('fetch', {
      ...defaultOptions,
      experimentalResponseSigning: { mode: 'observe', trustedRootCertificates: roots },
    })
    expect(String(url)).toContain('https://preview.ff-cdn.datad0g.com/precompute-assignments')
    const headers = new Headers(init.headers)
    expect(headers.get(SIGNING_VERSION_HEADER)).toBe('1')
    expect(headers.get(SIGNING_NONCE_HEADER)).toMatch(/^[0-9a-f]{32}$/)
    expect(headers.get('x-stream')).toBeNull()
    expect(headers.get('x-dd-feature-flags-capabilities')?.split(',')).toContain('response-signing-v1')
    expect(init.redirect).toBe('error')
  })
  test('each opted-in request carries a fresh nonce', async () => {
    const nonces = new Set<string | null>()
    const fetcher = createFlagsConfigurationFetcher({
      ...defaultOptions,
      experimentalResponseSigning: { mode: 'observe', trustedRootCertificates: roots },
    })
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    for (let i = 0; i < 3; i++) await fetcher(context)
    for (const [, init] of (global.fetch as jest.Mock).mock.calls)
      nonces.add(new Headers(init.headers).get(SIGNING_NONCE_HEADER))
    expect(nonces.size).toBe(3)
  })
})
test('the standalone fetcher honors a proxy override when selecting trust', () => {
  expect(() =>
    createFlagsConfigurationFetcher({
      ...defaultOptions,
      site: 'datad0g.com',
      flaggingProxy: 'https://proxy.test/assign',
      experimentalResponseSigning: { mode: 'required' },
    })
  ).toThrow('Flag response signing failed (missing-anchor)')
})
test.each(['observe', 'required'] as const)(
  '%s verifies the actual normalized request, token override, query and response before provider admission',
  async (mode) => {
    global.fetch = jest.fn(signed)
    const subject = provider(mode, {
      customHeaders: { 'dd-client-token': 'effective-token' },
      flaggingProxy: 'https://proxy.test/assign?marker=a%2Fb',
      experimentalResponseSigning: { mode, trustedRootCertificates: roots },
    })
    await subject.initialize(context)
    expect(evaluation(subject)).toBe(true)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain('marker=a%2Fb&dd_env=production')
    expect(new Headers(init.headers).get('dd-client-token')).toBe('effective-token')
    expect(new Headers(init.headers).get(SIGNING_NONCE_HEADER)).toMatch(/^[0-9a-f]{32}$/)
    expect(new Headers(init.headers).get(SIGNING_VERSION_HEADER)).toBe('1')
    expect(new Headers(init.headers).get('x-stream')).toBeNull()
    expect(new Headers(init.headers).get('x-dd-feature-flags-capabilities')?.split(',')).toContain(
      'response-signing-v1'
    )
    expect(assignmentRequests()).toHaveLength(1)
    expect(DatadogProvider.responseSigningVersion).toBe(1)
    expect(init.redirect).toBe('error')
  }
)
test('observe accepts unsigned and tampered ordinary responses without evaluation errors', async () => {
  const warn = jest.spyOn(display, 'warn').mockImplementation(() => undefined)
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const subject = provider('observe', {
    experimentalResponseSigning: { mode: 'observe', trustedRootCertificates: roots },
  })
  const errors = jest.fn()
  subject.events.addHandler(ProviderEvents.Error, errors)
  await subject.initialize(context)
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(true)
  global.fetch = jest.fn(async (url, init) => {
    const valid = await signed(String(url), init!)
    return response(JSON.stringify(payload(false)), valid.headers)
  })
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(false)
  await flush()
  expect(errors).not.toHaveBeenCalled()
  const details = subject.resolveBooleanEvaluation('critical', true, {}, logger)
  expect(details.reason).toBe(StandardResolutionReasons.TARGETING_MATCH)
  expect(details.errorCode).toBeUndefined()
  expect(details.errorMessage).toBeUndefined()
  // One warning for each reason code, without debug mode: two unsigned responses, then one tampered response.
  expect(warn.mock.calls).toEqual([
    [`${signingFailureMessage('missing-proof')} Flags are not verified.`],
    [`${signingFailureMessage('invalid-signature')} Flags are not verified.`],
  ])
})
test.each([401, 403, 500])('observe does not turn HTTP %i into a signing success', async (status) => {
  global.fetch = jest.fn().mockResolvedValue(response('{}', new Headers(), status))
  const subject = provider('observe', {
    experimentalResponseSigning: { mode: 'observe', trustedRootCertificates: roots },
  })
  await expect(subject.initialize(context)).rejects.toThrow('Failed to fetch flag configuration')
})
test('observe parser failure is not an optional verification failure', async () => {
  global.fetch = jest.fn().mockResolvedValue(response('invalid JSON'))
  await expect(provider('observe').initialize(context)).rejects.toThrow()
})
test('required rejects unsigned and tampered responses without unsigned retry', async () => {
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  await expect(provider('required').initialize(context)).rejects.toThrow('missing-proof')
  expect(assignmentRequests()).toHaveLength(1)
  global.fetch = jest.fn(async (url, init) => {
    const valid = await signed(String(url), init!)
    return response(JSON.stringify(payload(false)), valid.headers)
  })
  await expect(provider('required').initialize(context)).rejects.toThrow('invalid-signature')
  expect(assignmentRequests()).toHaveLength(1)
})
test('strict expiry: required uses matching verified memory until original expiry, including every evaluation', async () => {
  global.fetch = jest.fn(signed)
  const subject = provider('required', strict())
  await subject.initialize(context)
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await subject.onContextChange(context, context)
  expect(subject.status).toBe(ProviderStatus.STALE)
  expect(evaluation(subject)).toBe(true)
  jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
  expect(evaluation(subject)).toBe(false)
  await expect(subject.onContextChange(context, context)).rejects.toThrow('network unavailable')
})
test.each(['required', 'observe'] as const)(
  '%s proof expiry with expireVerifiedFlags: evaluation and OpenFeature lifecycle signals',
  async (mode) => {
    global.fetch = jest.fn(signed)
    const subject = provider(mode, {
      experimentalResponseSigning: { mode, trustedRootCertificates: roots, expireVerifiedFlags: true },
    })
    await subject.initialize(context)
    const resolve = () => subject.resolveBooleanEvaluation('critical', false, {}, logger)
    expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
    expect(subject.status).toBe(ProviderStatus.READY)

    // Subscribe after successful admission so initialization events do not mask expiry behavior.
    const stale = jest.fn()
    const error = jest.fn()
    const changed = jest.fn()
    subject.events.addHandler(ProviderEvents.Stale, stale)
    subject.events.addHandler(ProviderEvents.Error, error)
    subject.events.addHandler(ProviderEvents.ConfigurationChanged, changed)
    const requestsAfterAdmission = assignmentRequests().length

    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000 - 1)
    expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })

    // The proof is invalid at expiresAt, not one second later. Repeat reads after that boundary.
    for (const seconds of [300, 301]) {
      jest.spyOn(Date, 'now').mockReturnValue((vector.now + seconds) * 1000)
      for (let attempt = 0; attempt < 2; attempt++) {
        if (mode === 'required') {
          expect(resolve()).toMatchObject({
            value: false,
            reason: StandardResolutionReasons.ERROR,
            errorCode: ErrorCode.GENERAL,
            errorMessage: signingFailureMessage('expired-proof'),
          })
        } else {
          expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
        }
      }
    }
    // Flush asynchronous handlers. Only Date.now is controlled; this does not simulate browser timer scheduling.
    await flush()
    expect(subject.status).toBe(mode === 'required' ? ProviderStatus.ERROR : ProviderStatus.READY)
    expect(stale).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(mode === 'required' ? 1 : 0)
    if (mode === 'required') {
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: ErrorCode.GENERAL,
          message: signingFailureMessage('expired-proof'),
        })
      )
    }
    expect(changed).not.toHaveBeenCalled()
    expect(assignmentRequests()).toHaveLength(requestsAfterAdmission)

    // A fresh proof restores usability and permits another expiry episode to signal once.
    const ready = jest.fn()
    subject.events.addHandler(ProviderEvents.Ready, ready)
    global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 301))
    await subject.onContextChange(context, context)
    await flush()
    expect(subject.status).toBe(ProviderStatus.READY)
    expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
    expect(ready).toHaveBeenCalledTimes(mode === 'required' ? 1 : 0)
    expect(changed).toHaveBeenCalledTimes(1)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 601) * 1000)
    resolve()
    resolve()
    await flush()
    expect(error).toHaveBeenCalledTimes(mode === 'required' ? 2 : 0)
  }
)
test('strict expiry: OpenFeature clients receive expiry errors and recovery events', async () => {
  const domain = 'response-signing-expiry'
  const subject = provider('required', strict())
  global.fetch = jest.fn(signed)
  await OpenFeature.setProviderAndWait(domain, subject, context)
  const client = OpenFeature.getClient(domain)
  const errors = jest.fn()
  const ready = jest.fn()
  client.addHandler(ProviderEvents.Error, errors)
  client.addHandler(ProviderEvents.Ready, ready)
  try {
    expect(client.getBooleanDetails('critical', false)).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
    for (let i = 0; i < 2; i++) {
      expect(client.getBooleanDetails('critical', false)).toMatchObject({
        value: false,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.GENERAL,
        errorMessage: signingFailureMessage('expired-proof'),
      })
    }
    await flush()
    expect(client.providerStatus).toBe(ProviderStatus.ERROR)
    expect(errors).toHaveBeenCalledTimes(1)
    ready.mockClear()
    global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 300))
    await OpenFeature.setContext(domain, { ...context, refreshed: true })
    await flush()
    expect(client.providerStatus).toBe(ProviderStatus.READY)
    expect(client.getBooleanDetails('critical', false)).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
    expect(ready).toHaveBeenCalledTimes(1)
  } finally {
    client.removeHandler(ProviderEvents.Error, errors)
    client.removeHandler(ProviderEvents.Ready, ready)
    await OpenFeature.clearProviders()
  }
})

test('default expiry: required keeps the verified flags, goes STALE once, and recovers to READY', async () => {
  global.fetch = jest.fn(signed)
  const subject = provider('required')
  await subject.initialize(context)
  const resolve = () => subject.resolveBooleanEvaluation('critical', false, {}, logger)
  const stale = jest.fn()
  const error = jest.fn()
  const ready = jest.fn()
  subject.events.addHandler(ProviderEvents.Stale, stale)
  subject.events.addHandler(ProviderEvents.Error, error)
  subject.events.addHandler(ProviderEvents.Ready, ready)
  const requestsAfterAdmission = assignmentRequests().length
  for (const seconds of [300, 301, 3600]) {
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + seconds) * 1000)
    expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
    expect(resolve().errorCode).toBeUndefined()
  }
  await flush()
  expect(subject.status).toBe(ProviderStatus.STALE)
  expect(stale).toHaveBeenCalledTimes(1)
  expect(error).not.toHaveBeenCalled()
  // The SDK does not refetch by itself: the application decides.
  expect(assignmentRequests()).toHaveLength(requestsAfterAdmission)

  // A blocked refresh keeps the last verified values; it cannot replace them.
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await subject.onContextChange(context, context)
  await flush()
  expect(subject.status).toBe(ProviderStatus.STALE)
  expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })

  // A new verified response returns the provider to READY.
  global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 3600))
  await subject.onContextChange(context, context)
  await flush()
  expect(subject.status).toBe(ProviderStatus.READY)
  expect(ready).toHaveBeenCalledTimes(1)
  expect(resolve()).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })

  // After a restart, required mode has no flag data until the first verified response.
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  const restarted = provider('required')
  await expect(restarted.initialize(context)).rejects.toThrow('network unavailable')
  expect(restarted.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({ value: false })
})
test('default expiry: OpenFeature clients see STALE and keep the verified values', async () => {
  const domain = 'response-signing-stale'
  const subject = provider('required')
  global.fetch = jest.fn(signed)
  await OpenFeature.setProviderAndWait(domain, subject, context)
  const client = OpenFeature.getClient(domain)
  const stale = jest.fn()
  const errors = jest.fn()
  client.addHandler(ProviderEvents.Stale, stale)
  client.addHandler(ProviderEvents.Error, errors)
  try {
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
    for (let i = 0; i < 2; i++) {
      expect(client.getBooleanDetails('critical', false)).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
    }
    await flush()
    expect(client.providerStatus).toBe(ProviderStatus.STALE)
    expect(stale).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    client.removeHandler(ProviderEvents.Stale, stale)
    client.removeHandler(ProviderEvents.Error, errors)
    await OpenFeature.clearProviders()
  }
})
test('default expiry is logged as a stale policy', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
  global.fetch = jest.fn(signed)
  const subject = provider('required', { debugMode: true })
  await subject.initialize(context)
  jest.spyOn(Date, 'now').mockReturnValue((vector.now + 301) * 1000)
  expect(evaluation(subject)).toBe(true)
  const records = log.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[Datadog Feature Flags] '))
    .map((line) => JSON.parse(line.slice('[Datadog Feature Flags] '.length)))
  expect(records.find((record) => record.event === 'signing.expired').details.action).toBe('serve_verified_flags_stale')
  expect(
    records.filter((record) => record.event === 'evaluation.completed').slice(-1)[0].details.expirationPolicy
  ).toBe('stale_after_verified_proof_expiry')
})
describe('expiry timer at expires-at', () => {
  // Date stays under the jest.spyOn mock; only the timers are fake.
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'queueMicrotask', 'setImmediate'] }))
  afterEach(() => jest.useRealTimers())
  const settle = () => jest.advanceTimersByTimeAsync(100)
  test.each([
    [false, 'READY'],
    [false, 'STALE'],
    [true, 'READY'],
    [true, 'STALE'],
  ] as const)(
    'expireVerifiedFlags %s from %s: the timer changes the state with no evaluation',
    async (strictMode, from) => {
      global.fetch = jest.fn(signed)
      const subject = provider(
        'required',
        strictMode ? strict() : { experimentalResponseSigning: { mode: 'required', trustedRootCertificates: roots } }
      )
      await subject.initialize(context)
      if (from === 'STALE') {
        // A failed refresh falls back to the verified memory: the provider is STALE before the proof expires.
        global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
        const update = subject.onContextChange(context, context)
        await jest.advanceTimersByTimeAsync(30_000)
        await update
      }
      expect(subject.status).toBe(from === 'STALE' ? ProviderStatus.STALE : ProviderStatus.READY)
      const stale = jest.fn()
      const error = jest.fn()
      subject.events.addHandler(ProviderEvents.Stale, stale)
      subject.events.addHandler(ProviderEvents.Error, error)

      // One second before expiry nothing changes.
      jest.spyOn(Date, 'now').mockReturnValue((vector.now + 299) * 1000)
      await jest.advanceTimersByTimeAsync(299_000)
      expect(subject.status).toBe(from === 'STALE' ? ProviderStatus.STALE : ProviderStatus.READY)
      expect(error).not.toHaveBeenCalled()

      jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
      await jest.advanceTimersByTimeAsync(1_000)
      await settle()
      if (strictMode) {
        expect(subject.status).toBe(ProviderStatus.ERROR)
        expect(error).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: ErrorCode.GENERAL, message: signingFailureMessage('expired-proof') })
        )
        expect(stale).not.toHaveBeenCalled()
        expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
          value: false,
          errorCode: ErrorCode.GENERAL,
        })
      } else {
        expect(subject.status).toBe(ProviderStatus.STALE)
        // From STALE the state does not change, so no second STALE event is sent.
        expect(stale).toHaveBeenCalledTimes(from === 'READY' ? 1 : 0)
        expect(error).not.toHaveBeenCalled()
        expect(evaluation(subject)).toBe(true)
      }
      // The read check does not send the event again.
      subject.resolveBooleanEvaluation('critical', false, {}, logger)
      await settle()
      expect(error).toHaveBeenCalledTimes(strictMode ? 1 : 0)

      // A new verified response returns READY and schedules a new timer.
      global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 300))
      const refresh = subject.onContextChange(context, context)
      await settle()
      await refresh
      expect(subject.status).toBe(ProviderStatus.READY)
      jest.spyOn(Date, 'now').mockReturnValue((vector.now + 600) * 1000)
      await jest.advanceTimersByTimeAsync(300_000)
      await settle()
      expect(subject.status).toBe(strictMode ? ProviderStatus.ERROR : ProviderStatus.STALE)
      expect(error).toHaveBeenCalledTimes(strictMode ? 2 : 0)
    }
  )
  test('closing the provider cancels the expiry timer', async () => {
    global.fetch = jest.fn(signed)
    const subject = provider('required', strict())
    await subject.initialize(context)
    const error = jest.fn()
    subject.events.addHandler(ProviderEvents.Error, error)
    await subject.onClose()
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
    await jest.advanceTimersByTimeAsync(301_000)
    expect(error).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })
  /** A fetch that stays pending until the test ends it, so that closing the provider does not wait for it. */
  function pendingFetch() {
    let end: (error: Error) => void = () => undefined
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          end = reject
        })
    )
    return () => end(new Error('test ended'))
  }
  test.each(['no context change', 'a context change in flight', 'a failed context change'] as const)(
    'after expiry with %s, the timer does not re-arm in a loop',
    async (change) => {
      global.fetch = jest.fn(signed)
      const subject = provider('required')
      await subject.initialize(context)
      const other = { targetingKey: 'user-456' }
      let endFetch: () => void = () => undefined
      if (change === 'a context change in flight') {
        endFetch = pendingFetch()
        subject.onContextChange(context, other).catch(() => undefined)
      } else if (change === 'a failed context change') {
        global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
        const update = subject.onContextChange(context, other).catch(() => undefined)
        await jest.advanceTimersByTimeAsync(30_000)
        await update
      }
      // The requested context differs from the proof context, so the timer cannot signal the expiry.
      jest.spyOn(Date, 'now').mockReturnValue((vector.now + 301) * 1000)
      await jest.advanceTimersByTimeAsync(300_000)
      const schedules = jest.spyOn(subject as unknown as { scheduleProofExpiry(): void }, 'scheduleProofExpiry')
      await jest.advanceTimersByTimeAsync(1_000)
      expect(schedules.mock.calls.length).toBeLessThan(10)
      endFetch()
      await jest.advanceTimersByTimeAsync(100)
    }
  )
  test('after a large backward clock step, the timer delay stays in the 32-bit timer range', async () => {
    global.fetch = jest.fn(signed)
    const subject = provider('required')
    await subject.initialize(context)
    // With a context change in flight, the timer cannot signal the expiry and re-arms before expires-at.
    const endFetch = pendingFetch()
    subject.onContextChange(context, { targetingKey: 'user-456' }).catch(() => undefined)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now - 30 * 24 * 3600) * 1000)
    // The timer fires at expires-at and re-arms for about 30 days. A delay over the 32-bit range overflows and fires at
    // once, as in browsers, which makes a loop.
    await jest.advanceTimersByTimeAsync(300_000)
    const schedules = jest.spyOn(subject as unknown as { scheduleProofExpiry(): void }, 'scheduleProofExpiry')
    await jest.advanceTimersByTimeAsync(1_000)
    expect(schedules.mock.calls.length).toBeLessThan(10)
    endFetch()
    await jest.advanceTimersByTimeAsync(100)
  })
  test('observe mode schedules no expiry timer', async () => {
    global.fetch = jest.fn(signed)
    const subject = provider('observe')
    await subject.initialize(context)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
    await jest.advanceTimersByTimeAsync(301_000)
    expect(subject.status).toBe(ProviderStatus.READY)
  })
})
describe('RUM is not part of the signing scope', () => {
  // The browser application ID is a fixed init option. RUM only enriches the context when the application
  // changes it, so a RUM start, a RUM stop, or a RUM change during a fetch never invalidates verified flags.
  const rum = { enableRumFeatureFlagTracking: true }
  const setRumUser = (user?: Record<string, unknown>) => {
    if (user) Object.assign(globalThis, { DD_RUM: { getUser: () => user } })
    else delete (globalThis as { DD_RUM?: unknown }).DD_RUM
  }
  afterEach(() => setRumUser(undefined))
  test.each([
    ['RUM starts after init', undefined, { id: 'rum-user', plan: 'pro' }],
    ['RUM stops after init', { id: 'rum-user', plan: 'pro' }, undefined],
  ] as const)('%s: the verified flags stay READY with no refetch', async (_label, before, after) => {
    setRumUser(before)
    global.fetch = jest.fn(signed)
    const subject = provider('required', rum)
    await subject.initialize(context)
    const requests = assignmentRequests().length
    const stale = jest.fn()
    const error = jest.fn()
    subject.events.addHandler(ProviderEvents.Stale, stale)
    subject.events.addHandler(ProviderEvents.Error, error)
    setRumUser(after)
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.TARGETING_MATCH,
    })
    await flush()
    expect(subject.status).toBe(ProviderStatus.READY)
    expect(assignmentRequests()).toHaveLength(requests)
    expect(stale).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
  test('the RUM context changes during a fetch: the response is still admitted, and dd-application-id is bound', async () => {
    global.fetch = jest.fn(signed)
    const subject = provider('required', rum)
    await subject.initialize(context)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent: RequestInit | undefined
    global.fetch = jest.fn(async (url, init) => {
      // Telemetry batches share global.fetch; only the assignment request is under test.
      if (!String(url).includes('/precompute-assignments')) return response('{}')
      sent = init
      await gate
      return signed(url, init, true, vector.now + 10)
    })
    const update = subject.onContextChange(context, { ...context, plan: 'team' })
    setRumUser({ id: 'rum-user', plan: 'pro' })
    release()
    await update
    await flush()
    expect(subject.status).toBe(ProviderStatus.READY)
    expect(evaluation(subject)).toBe(true)
    // The transcript binds the header that was sent; the configured application ID did not change.
    expect(new Headers(sent?.headers).get('dd-application-id')).toBe('app-a')
    // The per-response binding stays: a proof made for another application ID does not verify.
    global.fetch = jest.fn(async (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set('dd-application-id', 'app-b')
      return signed(url, { ...init, headers }, true, vector.now + 20)
    })
    await expect(subject.onContextChange(context, { ...context, plan: 'enterprise' })).rejects.toThrow(
      'invalid-signature'
    )
  })
})
test('strict expiry does not overwrite an in-flight context reconciliation', async () => {
  const subject = provider('required', strict())
  global.fetch = jest.fn(signed)
  await subject.initialize(context)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  global.fetch = jest.fn(async (url, init) => {
    await gate
    return signed(url, init, true, vector.now + 300)
  })
  const errors = jest.fn()
  subject.events.addHandler(ProviderEvents.Error, errors)
  const update = subject.onContextChange(context, context)
  jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
  expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
    value: false,
    errorCode: ErrorCode.GENERAL,
    errorMessage: signingFailureMessage('expired-proof'),
  })
  expect(subject.status).toBe(ProviderStatus.RECONCILING)
  release()
  await update
  await flush()
  expect(subject.status).toBe(ProviderStatus.READY)
  expect(evaluation(subject)).toBe(true)
  expect(errors).not.toHaveBeenCalled()
})
test('required rejects bootstrap, legacy persistence and verified data after restart', async () => {
  const bootstrap = { precomputed: { response: payload(), context, fetchedAt: 1 as any } }
  new IndexedDBFlagsCache(defaultOptions.clientToken).set(bootstrap as any, context)
  await flush()
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await expect(
    provider('required', { initialFlagsConfiguration: bootstrap as any }).initialize(context)
  ).rejects.toThrow()
  global.fetch = jest.fn(signed)
  await provider('required').initialize(context)
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await expect(provider('required').initialize(context)).rejects.toThrow()
})
test('unverified observe refresh cannot replace the separate verified memory fallback', async () => {
  global.fetch = jest.fn(signed)
  const subject = provider('observe')
  await subject.initialize(context)
  global.fetch = jest.fn().mockResolvedValue(unsigned(false))
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(false)
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(true)
})

test.each(['9007199254740993', '1e-999', '1e999'])(
  'retains numeric token %s when observe mode continues without a signing request',
  async (token) => {
    const signing = createResponseSigningController({ mode: 'observe', trustedRootCertificates: roots }, STAGING)!
    const request = await signing.prepare(
      'https://example.test/assign',
      { 'dd-client-token': 'a', 'DD-Client-Token': 'b' },
      '{}'
    )
    expect(request).toBeUndefined()
    const raw = JSON.stringify(payload()).replace(
      '"variationType":"boolean","variationValue":true',
      `"variationType":"number","variationValue":${token}`
    )
    const read = await signing.read(response(raw), request)
    expect(read.proof).toBeUndefined()
    const parsed = parsePrecomputedConfigurationResponse(read.json)
    if ('error' in parsed) throw new Error(parsed.error)
    expect(evaluatePrecomputedConfiguration({ precomputed: parsed }, 'number', 'critical', -99.5, {})).toMatchObject({
      value: -99.5,
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH',
    })
  }
)
test('public v1 persistence is isolated from prototype signing cache namespaces', async () => {
  const signing = createResponseSigningController({ mode: 'observe', trustedRootCertificates: roots }, STAGING)!
  const namespace = await signing.cacheNamespace()
  expect(namespace).toMatch(/^response-signing-v1-[0-9a-f]{64}$/)
  const prototypeScope = JSON.stringify({ version: 3, mode: 'observe', roots, scope: STAGING })
  const prototypeHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(prototypeScope))).toString(
    'hex'
  )
  expect(namespace).not.toBe(`response-signing-v3-${prototypeHash}`)
  expect(namespace).not.toBe(`response-signing-v1-${prototypeHash}`)
})
test('observe preserves unverified persistence only for the same complete scope', async () => {
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  await provider('observe').initialize(context)
  await flush()
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  const restarted = provider('observe')
  await restarted.initialize(context)
  expect(restarted.status).toBe(ProviderStatus.STALE)
  expect(evaluation(restarted)).toBe(true)
  for (const change of [
    { clientToken: 'token-b' },
    { env: 'staging' },
    { applicationId: 'app-b' },
    { flaggingProxy: 'https://other.test/' },
  ]) {
    await expect(provider('observe', change).initialize(context)).rejects.toThrow()
  }
  await expect(provider('observe').initialize({ ...context, nested: { plan: 'enterprise' } })).rejects.toThrow()
})
test('new context aborts an older verification before memory or persistent cache writes', async () => {
  const originalVerify = cryptoBridge.subtle.verify
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  jest.spyOn(cryptoBridge.subtle, 'verify').mockImplementation(async (...args) => {
    if (first) {
      first = false
      entered()
      await gate
    }
    return originalVerify(...args)
  })
  global.fetch = jest.fn(signed)
  const subject = provider('observe')
  const old = subject.initialize(context)
  await blocked
  const next = { ...context, targetingKey: 'new-user' }
  await subject.onContextChange(context, next)
  release()
  await old
  await flush()
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await expect(provider('observe').initialize(context)).rejects.toThrow()
  expect(evaluation(subject)).toBe(true)
})
test('direct fetch opt-in verifies and rejects unsupported HTTP requests locally in required mode', async () => {
  global.fetch = jest.fn(signed)
  await expect(
    fetchPrecomputedConfiguration({
      ...defaultOptions,
      env: 'production',
      context,
      experimentalResponseSigning: { mode: 'required', trustedRootCertificates: roots },
    })
  ).resolves.toHaveProperty('precomputed')
  const signing = createResponseSigningController({ mode: 'required', trustedRootCertificates: roots }, STAGING)!
  await expect(signing.prepare('http://example.test/', { 'dd-client-token': 'test' }, '{}')).rejects.toThrow(
    'unsupported-request'
  )
})

test('direct fetch combines flag selection with required response signing', async () => {
  global.fetch = jest.fn(async (url, init) => {
    expect(JSON.parse(init?.body as string).data.attributes.flag_selection).toEqual({
      tags: ['beta'],
      key_patterns: ['critical*'],
    })
    expect(new Headers(init?.headers).get(SIGNING_VERSION_HEADER)).toBe('1')
    expect(init?.redirect).toBe('error')
    return signed(url, init)
  })

  await expect(
    fetchPrecomputedConfiguration({
      ...defaultOptions,
      env: 'production',
      context,
      flagSelection: { tags: [' beta ', 'beta'], keyPatterns: ['critical*'] },
      experimentalResponseSigning: { mode: 'required', trustedRootCertificates: roots },
    })
  ).resolves.toHaveProperty('precomputed')
  expect(assignmentRequests()).toHaveLength(1)
})

test('observe retains network availability without WebCrypto; required fails before fetch', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const observer = provider('observe', { experimentalResponseSigning: { mode: 'observe' } })
  await observer.initialize(context)
  expect(evaluation(observer)).toBe(true)
  expect(new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers).get(SIGNING_VERSION_HEADER)).toBeNull()
  ;(global.fetch as jest.Mock).mockClear()
  await expect(provider('required').initialize(context)).rejects.toThrow('unavailable-crypto')
  expect(assignmentRequests()).toHaveLength(0)
})

test('observe without a provisioned anchor accepts responses and required never promotes its cached entry', async () => {
  global.fetch = jest.fn(signed)
  const observer = provider('observe', { experimentalResponseSigning: { mode: 'observe' } })
  await observer.initialize(context)
  expect(evaluation(observer)).toBe(true)
  await flush()
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await expect(provider('required').initialize(context)).rejects.toThrow('network unavailable')
})

test('signed provider snapshots nested context and configured header overrides', async () => {
  const mutable = { targetingKey: 'user-123', nested: { plan: 'team' } }
  const headers = { 'dd-client-token': 'effective-token' }
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let sent: Headers | undefined
  global.fetch = jest.fn(async (url, init) => {
    sent = new Headers(init?.headers)
    await gate
    return signed(url, init)
  })
  const subject = provider('required', { customHeaders: headers })
  headers['dd-client-token'] = 'changed-after-construction'
  const initialized = subject.initialize(mutable)
  mutable.nested.plan = 'changed-while-verifying'
  release()
  await initialized
  expect(sent!.get('dd-client-token')).toBe('effective-token')
  expect(evaluation(subject)).toBe(true)
  global.fetch = jest.fn().mockRejectedValue(new Error('network unavailable'))
  await expect(subject.onContextChange(context, mutable)).rejects.toThrow('network unavailable')
  expect(evaluation(subject)).toBe(false)
})

describe('backward clock step', () => {
  // The tolerance is 30 s, the same as for issued-at. A larger step is handled as proof expiry.
  const modes = [
    ['default', {}, ProviderStatus.STALE],
    ['expireVerifiedFlags', strict(), ProviderStatus.ERROR],
  ] as const
  async function verifiedProvider(extra: Partial<FlaggingInitConfiguration>) {
    global.fetch = jest.fn(signed)
    const subject = provider('required', extra)
    await subject.initialize(context)
    const events = { ready: jest.fn(), stale: jest.fn(), error: jest.fn() }
    subject.events.addHandler(ProviderEvents.Ready, events.ready)
    subject.events.addHandler(ProviderEvents.Stale, events.stale)
    subject.events.addHandler(ProviderEvents.Error, events.error)
    return { subject, events }
  }

  test.each(modes)('%s: a step of 30 s keeps the verified flags current', async (_name, extra, _expired) => {
    const { subject, events } = await verifiedProvider(extra)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now - 30) * 1000)
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({ value: true })
    await flush()
    expect(subject.status).toBe(ProviderStatus.READY)
    expect(events.stale).not.toHaveBeenCalled()
    expect(events.error).not.toHaveBeenCalled()
  })

  test('default: a step of more than 30 s is STALE and keeps the verified flags', async () => {
    const { subject, events } = await verifiedProvider({})
    jest.spyOn(Date, 'now').mockReturnValue((vector.now - 31) * 1000)
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({ value: true })
    await flush()
    expect(subject.status).toBe(ProviderStatus.STALE)
    expect(events.stale).toHaveBeenCalledTimes(1)
    expect(events.error).not.toHaveBeenCalled()
  })

  test('expireVerifiedFlags: a step of more than 30 s is ERROR with expired-proof', async () => {
    const { subject, events } = await verifiedProvider(strict())
    jest.spyOn(Date, 'now').mockReturnValue((vector.now - 31) * 1000)
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
      value: false,
      errorCode: ErrorCode.GENERAL,
      errorMessage: signingFailureMessage('expired-proof'),
    })
    await flush()
    expect(subject.status).toBe(ProviderStatus.ERROR)
    expect(events.error).toHaveBeenCalledTimes(1)
    expect(events.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: signingFailureMessage('expired-proof') })
    )
  })

  test.each(modes)('%s: the provider recovers to READY when the clock returns', async (_name, extra, expired) => {
    const { subject, events } = await verifiedProvider(extra)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now - 120) * 1000)
    evaluation(subject)
    await flush()
    expect(subject.status).toBe(expired)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 10) * 1000)
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({ value: true })
    await flush()
    expect(subject.status).toBe(ProviderStatus.READY)
    expect(events.ready).toHaveBeenCalledTimes(1)
    // The proof still expires at expires-at after the recovery.
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 300) * 1000)
    evaluation(subject)
    await flush()
    expect(subject.status).toBe(expired)
  })
})

/** Counts the records in every IndexedDB database and object store. */
async function indexedDBRecords(): Promise<number> {
  let count = 0
  for (const { name } of await indexedDB.databases()) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name!)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    for (const store of Array.from(database.objectStoreNames)) {
      count += await new Promise<number>((resolve, reject) => {
        const request = database.transaction(store).objectStore(store).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    database.close()
  }
  return count
}
test.each([
  ['observe', true],
  ['required', false],
] as const)('%s mode writes flag data to IndexedDB: %s', async (mode, writes) => {
  global.fetch = jest.fn(signed)
  const subject = provider(mode)
  await subject.initialize(context)
  await subject.onContextChange(context, { ...context, nested: { plan: 'enterprise' } })
  expect(evaluation(subject)).toBe(true)
  await flush()
  if (writes) expect(await indexedDBRecords()).toBeGreaterThan(0)
  else expect(await indexedDBRecords()).toBe(0)
})

test('required accepts a response issued 30 s in the future and rejects 31 s', async () => {
  global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 30))
  const accepted = provider('required')
  await accepted.initialize(context)
  expect(accepted.status).toBe(ProviderStatus.READY)
  expect(evaluation(accepted)).toBe(true)
  global.fetch = jest.fn((url, init) => signed(url, init, true, vector.now + 31))
  const rejected = provider('required')
  await expect(rejected.initialize(context)).rejects.toMatchObject({ reason: 'expired-proof' })
  expect(evaluation(rejected)).toBe(false)
})

test('direct required fetch binds admission to the original nested context across asynchronous verification', async () => {
  const mutable = { targetingKey: 'before', nested: { plan: 'team' } }
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requestBody: string | undefined
  global.fetch = jest.fn(async (url, init) => {
    requestBody = init?.body as string
    await gate
    return signed(url, init)
  })
  const pending = fetchPrecomputedConfiguration({
    ...defaultOptions,
    env: 'production',
    context: mutable,
    experimentalResponseSigning: { mode: 'required', trustedRootCertificates: roots },
  })
  mutable.targetingKey = 'after'
  mutable.nested.plan = 'enterprise'
  release()
  const configuration = await pending
  expect(JSON.parse(requestBody!).data.attributes.subject.targeting_key).toBe('before')
  expect(configuration.precomputed!.context).toEqual({ targetingKey: 'before', nested: { plan: 'team' } })
  expect(configuration.precomputed!.context).not.toBe(mutable)
})

test.each(['observe', 'required'] as const)(
  '%s rejects a redirected custom-transport response without unsigned retry',
  async (mode) => {
    global.fetch = jest.fn().mockResolvedValue({ ...unsigned(), redirected: true })
    await expect(
      fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context,
        experimentalResponseSigning: { mode, trustedRootCertificates: roots },
      })
    ).rejects.toThrow('redirects')
    expect(assignmentRequests()).toHaveLength(1)
  }
)

test('observe rejects redirects even when unavailable crypto prevented forming a signing request', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  global.fetch = jest.fn().mockResolvedValue({ ...unsigned(), redirected: true })
  await expect(
    fetchPrecomputedConfiguration({
      ...defaultOptions,
      env: 'production',
      context,
      experimentalResponseSigning: { mode: 'observe' },
    })
  ).rejects.toThrow('redirects')
  expect(assignmentRequests()).toHaveLength(1)
})

test('invalid ordinary configuration cannot downgrade required mode or admit bootstrap data', () => {
  const initialFlagsConfiguration = { precomputed: { response: payload(), context, fetchedAt: 1 as any } }
  for (const trustedRootCertificates of [roots, []]) {
    expect(() =>
      provider('required', {
        clientToken: '',
        initialFlagsConfiguration: initialFlagsConfiguration as any,
        experimentalResponseSigning: { mode: 'required', trustedRootCertificates },
      })
    ).toThrow('valid provider configuration')
  }
})

describe('required response stream reads', () => {
  async function setup() {
    const signing = createResponseSigningController({ mode: 'required', trustedRootCertificates: roots }, STAGING)!
    const request = (await signing.prepare('https://example.test/assign', { 'dd-client-token': 'test' }, '{}'))!
    return { signing, request }
  }

  function streamed(body: ReadableStream<Uint8Array>, headers = new Headers()): Response {
    return { ...response('', headers), body } as unknown as Response
  }

  test.each(['9007199254740993', '1e-999', '1e999'])(
    'retains numeric token %s after successful verification',
    async (token) => {
      const { signing, request } = await setup()
      const raw = JSON.stringify(payload()).replace(
        '"variationType":"boolean","variationValue":true',
        `"variationType":"number","variationValue":${token}`
      )
      const result = await signed(request.url, { headers: request.headers, body: '{}' }, true, vector.now, raw)
      const read = await signing.read(result, request)
      expect(read.proof).toMatchObject({ expiresAt: vector.now + 300 })
      const parsed = parsePrecomputedConfigurationResponse(read.json)
      if ('error' in parsed) throw new Error(parsed.error)
      expect(evaluatePrecomputedConfiguration({ precomputed: parsed }, 'number', 'critical', -99.5, {})).toMatchObject({
        value: -99.5,
        reason: 'ERROR',
        errorCode: 'TYPE_MISMATCH',
      })
    }
  )

  test.each([false, true])('rejects overflow and handles cancellation (rejects: %s)', async (rejectCancel) => {
    const { signing, request } = await setup()
    for (let attempt = 0; attempt < 2; attempt++) {
      const cancel = jest.fn(() => (rejectCancel ? Promise.reject(new Error('cancel failed')) : Promise.resolve()))
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SIGNED_RESPONSE))
          controller.enqueue(new Uint8Array(1))
        },
        cancel,
      })
      await expect(signing.read(streamed(body), request)).rejects.toMatchObject({ reason: 'response-too-large' })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
      // Give rejected cleanup promises a turn to surface as unhandled rejections in Jest.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })

  test('verifies a valid signed response delivered in chunks', async () => {
    const { signing, request } = await setup()
    const result = await signed(request.url, { headers: request.headers, body: '{}' })
    const data = new Uint8Array(await result.arrayBuffer())
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.slice(0, 10))
        controller.enqueue(data.slice(10))
        controller.close()
      },
    })
    await expect(signing.read(streamed(body, result.headers), request)).resolves.toMatchObject({
      json: payload(),
      proof: { expiresAt: vector.now + 300 },
    })
    expect(body.locked).toBe(false)
  })

  test('preserves ordinary stream failures without replacing the error', async () => {
    const { signing, request } = await setup()
    const error = new Error('stream failed')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error)
      },
    })
    await expect(signing.read(streamed(body), request)).rejects.toBe(error)
    expect(body.locked).toBe(false)
  })
})

describe('Date-valued signing contexts', () => {
  const dateContext = () => ({
    targetingKey: 'date-user',
    joined: new Date(0),
    nested: { renewed: new Date(1000) },
    dates: [new Date(2000)],
    text: new Date(0).toISOString(),
  })
  const expectedAttributes = () =>
    Object.fromEntries(
      Object.entries(dateContext()).map(([key, value]) => [
        key,
        typeof value === 'string' ? value : JSON.stringify(value),
      ])
    )

  describe.each(['provider', 'direct fetch'] as const)('%s request compatibility', (entry) => {
    test.each(['off', 'observe', 'required'] as const)('%s preserves Date request values', async (mode) => {
      global.fetch = mode === 'off' ? jest.fn().mockResolvedValue(unsigned()) : jest.fn(signed)
      const input = dateContext()
      if (entry === 'provider') {
        await provider(mode).initialize(input)
      } else {
        await fetchPrecomputedConfiguration({
          ...defaultOptions,
          env: 'production',
          context: input,
          experimentalResponseSigning: { mode, trustedRootCertificates: roots },
        })
      }
      const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
      const attributes = JSON.parse(init.body as string).data.attributes.subject.targeting_attributes
      expect(attributes).toEqual(expectedAttributes())
      expect(attributes.joined).not.toBe(attributes.text)
    })
  })

  test.each(['observe', 'required'] as const)(
    '%s retains a detached Date snapshot during direct fetch',
    async (mode) => {
      const input = dateContext()
      let release: () => void = () => {}
      let entered: () => void = () => {}
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      global.fetch = jest.fn(async (url, init) => {
        entered()
        await gate
        return signed(url, init)
      })
      const pending = fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context: input,
        experimentalResponseSigning: { mode, trustedRootCertificates: roots },
      })
      await started
      input.joined.setTime(10000)
      input.nested.renewed.setTime(11000)
      input.dates[0].setTime(12000)
      release()
      const result = await pending
      const snapshot = result.precomputed?.context
      if (!snapshot) throw new Error('Expected precomputed context')
      expect(snapshot).toEqual(dateContext())
      expect(snapshot.joined).not.toBe(input.joined)
      expect((snapshot.nested as { renewed: Date }).renewed).not.toBe(input.nested.renewed)
      expect((snapshot.dates as Date[])[0]).not.toBe(input.dates[0])
      const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
      expect(JSON.parse(init.body as string).data.attributes.subject.targeting_attributes).toEqual(expectedAttributes())
    }
  )

  test.each(['observe', 'required'] as const)('%s provider keeps in-flight Date values detached', async (mode) => {
    const input = dateContext()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    global.fetch = jest.fn(async (url, init) => {
      entered()
      await gate
      return signed(url, init)
    })
    const subject = provider(mode)
    const pending = subject.initialize(input)
    await started
    input.joined.setTime(10000)
    input.nested.renewed.setTime(11000)
    input.dates[0].setTime(12000)
    release()
    await pending
    expect(evaluation(subject)).toBe(true)
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string).data.attributes.subject.targeting_attributes).toEqual(expectedAttributes())
  })

  test.each([
    ['top-level', { d: new Date(0) }, { d: new Date(1) }],
    ['nested', { n: { d: new Date(0) } }, { n: { d: new Date(1) } }],
    ['array', { dates: [new Date(0)] }, { dates: [new Date(1)] }],
    ['Date versus string', { d: new Date(0) }, { d: new Date(0).toISOString() }],
    ['Date versus object', { d: new Date(0) }, { d: {} }],
    ['Date versus tag-shaped array', { d: new Date(0) }, { d: ['date', 0] }],
    ['invalid Date versus null', { d: new Date(Number.NaN) }, { d: null }],
  ])('context identity distinguishes %s values', (_name, first, second) => {
    expect(signingContextKey(first)).not.toBe(signingContextKey(second))
  })

  test('context identity is stable for equal Date values and reordered keys', () => {
    expect(signingContextKey({ d: new Date(0), n: { b: 2, a: new Date(1) } })).toBe(
      signingContextKey({ n: { a: new Date(1), b: 2 }, d: new Date(0) })
    )
  })
})

test.each(['missing-proof', 'invalid-signature', 'response-too-large'] as const)(
  'required exposes %s through OpenFeature errors and evaluation details',
  async (reason) => {
    global.fetch = jest.fn(async (url, init) => {
      if (reason === 'missing-proof') return unsigned()
      if (reason === 'response-too-large') return response(' '.repeat(MAX_SIGNED_RESPONSE + 1))
      const valid = await signed(String(url), init!)
      return response(JSON.stringify(payload(false)), valid.headers)
    })
    const subject = provider('required')
    const errors = jest.fn()
    subject.events.addHandler(ProviderEvents.Error, errors)
    await expect(subject.initialize(context)).rejects.toMatchObject({
      code: ErrorCode.GENERAL,
      message: signingFailureMessage(reason),
    })
    await flush()
    // The OpenFeature SDK emits the only ERROR event for the rejected call. See the OpenFeature client test below.
    expect(errors).not.toHaveBeenCalled()
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: signingFailureMessage(reason),
    })
    global.fetch = jest.fn(signed)
    await subject.onContextChange(context, context)
    const recovered = subject.resolveBooleanEvaluation('critical', false, {}, logger)
    expect(recovered).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
    expect(recovered.errorCode).toBeUndefined()
    expect(recovered.errorMessage).toBeUndefined()
  }
)

/**
 * One signing failure emits one ERROR event. The OpenFeature SDK emits it for the rejected initialize or
 * onContextChange call, and @openfeature/core copies only the message, so the event has no errorCode.
 * Evaluations return errorCode GENERAL and the signing failure message.
 */
describe.each(['missing-proof', 'invalid-signature', 'response-too-large'] as const)(
  'required %s: one OpenFeature ERROR event per failure',
  (reason) => {
    const failing = async (url: RequestInfo | URL, init?: RequestInit) => {
      if (reason === 'missing-proof') return unsigned()
      if (reason === 'response-too-large') return response(' '.repeat(MAX_SIGNED_RESPONSE + 1))
      const valid = await signed(String(url), init!)
      return response(JSON.stringify(payload(false)), valid.headers)
    }
    async function expectOneErrorEvent(errors: jest.Mock, prefix: string) {
      await flush()
      expect(errors).toHaveBeenCalledTimes(1)
      expect(errors.mock.calls[0][0]).toMatchObject({ message: `${prefix}${signingFailureMessage(reason)}` })
      expect(errors.mock.calls[0][0].errorCode).toBeUndefined()
    }
    function expectSigningEvaluationError(domain: string) {
      expect(OpenFeature.getClient(domain).getBooleanDetails('critical', false)).toMatchObject({
        value: false,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.GENERAL,
        errorMessage: signingFailureMessage(reason),
      })
    }

    test('at initialization', async () => {
      const domain = `response-signing-init-${reason}`
      const errors = jest.fn()
      OpenFeature.getClient(domain).addHandler(ProviderEvents.Error, errors)
      try {
        global.fetch = jest.fn(failing)
        await expect(OpenFeature.setProviderAndWait(domain, provider('required'), context)).rejects.toThrow(
          signingFailureMessage(reason)
        )
        await expectOneErrorEvent(errors, '')
        expect(OpenFeature.getClient(domain).providerStatus).toBe(ProviderStatus.ERROR)
        expectSigningEvaluationError(domain)
      } finally {
        OpenFeature.getClient(domain).removeHandler(ProviderEvents.Error, errors)
        await OpenFeature.clearProviders()
      }
    })

    test('after a context change', async () => {
      const domain = `response-signing-change-${reason}`
      global.fetch = jest.fn(signed)
      await OpenFeature.setProviderAndWait(domain, provider('required'), context)
      const errors = jest.fn()
      OpenFeature.getClient(domain).addHandler(ProviderEvents.Error, errors)
      try {
        global.fetch = jest.fn(failing)
        await OpenFeature.setContext(domain, { ...context, refreshed: true })
        await expectOneErrorEvent(errors, "Error running datadog's context change handler: ")
        expect(OpenFeature.getClient(domain).providerStatus).toBe(ProviderStatus.ERROR)
        expectSigningEvaluationError(domain)
      } finally {
        OpenFeature.getClient(domain).removeHandler(ProviderEvents.Error, errors)
        await OpenFeature.clearProviders()
      }
    })
  }
)

test('OpenFeature clients receive verification failure details after a context change', async () => {
  const domain = 'response-signing-failure'
  global.fetch = jest.fn(signed)
  const subject = provider('required')
  await OpenFeature.setProviderAndWait(domain, subject, context)
  const client = OpenFeature.getClient(domain)
  const errors = jest.fn()
  client.addHandler(ProviderEvents.Error, errors)
  try {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    await OpenFeature.setContext(domain, { targetingKey: 'new-user' }).catch(() => undefined)
    await flush()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls[0][0].message).toContain(signingFailureMessage('missing-proof'))
    expect(client.getBooleanDetails('critical', false)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: signingFailureMessage('missing-proof'),
    })
  } finally {
    client.removeHandler(ProviderEvents.Error, errors)
    await OpenFeature.clearProviders()
  }
})

describe('response signing with assignment authorization', () => {
  test.each(['provider', 'standalone'] as const)('%s keeps tokens out of signed context snapshots', async (entry) => {
    const token = 'assignment.jwt.signature'
    const tokenContext = { ...context, dd_assignment_token: token, joined: new Date('2026-01-01T00:00:00Z') }
    const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('DD-Assignment-Token')).toBe(token)
      expect(init?.body).not.toContain(token)
      expect(init?.body).not.toContain('dd_assignment_token')
      expect(init?.body).toContain('2026-01-01T00:00:00.000Z')
      return signed(url, init)
    })
    global.fetch = fetchMock
    if (entry === 'provider') {
      const subject = provider('required')
      await subject.initialize(tokenContext)
      expect(evaluation(subject)).toBe(true)
    } else {
      const config = await fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context: tokenContext,
        experimentalResponseSigning: { mode: 'required', trustedRootCertificates: roots },
      })
      expect(config.precomputed?.context).not.toHaveProperty('dd_assignment_token')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(tokenContext.dd_assignment_token).toBe(token)
  })

  test('required verification rejects same-subject fallback when signed attributes change', async () => {
    global.fetch = jest.fn(signed)
    const subject = provider('required')
    const initial = { ...context, dd_assignment_token: 'first.jwt.signature' }
    await subject.initialize(initial)
    global.fetch = jest.fn().mockRejectedValue(new Error('transport failure'))
    await subject.onContextChange(initial, { ...initial, dd_assignment_token: 'second.jwt.signature' })
    expect(evaluation(subject)).toBe(true)
    const changed = { ...initial, nested: { plan: 'other' } }
    await expect(subject.onContextChange(initial, changed)).rejects.toThrow('transport error')
    expect(evaluation(subject)).toBe(false)
  })

  test('token-bearing missing proofs retain canonical signing errors', async () => {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    const subject = provider('required')
    const events = jest.fn()
    subject.events.addHandler(ProviderEvents.Error, events)
    await expect(subject.initialize({ ...context, dd_assignment_token: 'assignment.jwt.signature' })).rejects.toThrow(
      signingFailureMessage('missing-proof')
    )
    // The rejection carries the canonical message. The OpenFeature SDK emits the ERROR event for it.
    expect(events).not.toHaveBeenCalled()
  })

  test('signed transport parsing errors do not expose echoed assignment credentials', async () => {
    const token = 'assignment.jwt.signature'
    global.fetch = jest.fn().mockResolvedValue(response(`invalid JSON ${token}`))
    await expect(
      fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context: { ...context, dd_assignment_token: token },
        experimentalResponseSigning: { mode: 'observe', trustedRootCertificates: roots },
      })
    ).rejects.toThrow('Assignment response is not valid JSON')
  })
})

/**
 * Credential cutover: until the rotator republishes the credential, the staging edge can return an
 * ordinary 200 response without proof, even to an opted-in request. Required fails closed; observe
 * accepts the response as unverified and reports the failure. Neither mode retries.
 */
describe('missing proof on an opted-in staging response (credential cutover)', () => {
  let log: jest.SpyInstance
  const events = (name: string) =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((record) => record.event === name)
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
  })
  const responses = {
    'no proof headers': () => unsigned(),
    'only the removed signing-intermediate header': () =>
      response(
        JSON.stringify(payload()),
        new Headers({
          'x-datadog-feature-flags-signature-version': '1',
          'x-datadog-feature-flags-signing-certificate': credential.leafBase64,
          'x-datadog-feature-flags-signing-intermediate': credential.intermediatesBase64[0],
        })
      ),
  }
  // The bundled staging root is selected from the staging endpoint; no explicit roots are configured.
  const staging = (mode: 'observe' | 'required') =>
    provider(mode, { debugMode: true, experimentalResponseSigning: { mode } })
  test.each(Object.keys(responses) as Array<keyof typeof responses>)('required fails closed with %s', async (kind) => {
    global.fetch = jest.fn().mockResolvedValue(responses[kind]())
    const subject = staging('required')
    await expect(subject.initialize(context)).rejects.toThrow(signingFailureMessage('missing-proof'))
    expect(assignmentRequests()).toHaveLength(1)
    const details = subject.resolveBooleanEvaluation('critical', false, {}, logger)
    expect(details.value).toBe(false)
    expect(details.reason).toBe(StandardResolutionReasons.ERROR)
    expect(details.errorCode).toBe(ErrorCode.GENERAL)
    expect(events('signing.failed')[0].details).toMatchObject({
      mode: 'required',
      reason: 'missing-proof',
      action: 'reject_response',
    })
  })
  test.each(Object.keys(responses) as Array<keyof typeof responses>)(
    'observe accepts as unverified and reports the failure with %s',
    async (kind) => {
      global.fetch = jest.fn().mockResolvedValue(responses[kind]())
      const subject = staging('observe')
      const errors = jest.fn()
      subject.events.addHandler(ProviderEvents.Error, errors)
      await subject.initialize(context)
      expect(assignmentRequests()).toHaveLength(1)
      expect(evaluation(subject)).toBe(true)
      expect(errors).not.toHaveBeenCalled()
      expect(events('signing.failed')[0].details).toMatchObject({
        mode: 'observe',
        reason: 'missing-proof',
        action: 'continue_unverified',
      })
      expect(events('signing.verified')[0].details.outcome).toBe('unverified')
      // Let the unverified observe cache write finish inside the test.
      await flush()
    }
  )
})

describe('response signing debug diagnostics', () => {
  let log: jest.SpyInstance
  const events = (name: string) =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((record) => record.event === name)
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  test.each(['observe', 'required'] as const)(
    'logs %s verification failures without changing admission',
    async (mode) => {
      global.fetch = jest.fn().mockResolvedValue(unsigned())
      const subject = provider(mode, { debugMode: true })
      if (mode === 'required') await expect(subject.initialize(context)).rejects.toThrow()
      else {
        await subject.initialize(context)
        expect(evaluation(subject)).toBe(true)
      }
      expect(events('signing.failed')[0].details).toMatchObject({
        mode,
        action: mode === 'required' ? 'reject_response' : 'continue_unverified',
      })
      expect(JSON.stringify(log.mock.calls)).not.toContain('token-a')
    }
  )

  test('logs verified memory fallback and proof expiry, without cloning the bounded response stream', async () => {
    const clone = jest.fn(() => {
      throw new Error('must not clone')
    })
    global.fetch = jest.fn(async (url, init) => Object.assign(await signed(url, init), { clone }))
    const subject = provider('required', { ...strict(), debugMode: true })
    await subject.initialize(context)
    expect(events('signing.verified')[0].details.outcome).toBe('verified')
    expect(clone).not.toHaveBeenCalled()
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'))
    await subject.onContextChange(context, context)
    expect(events('cache.fallback').slice(-1)[0].details.source).toBe('verified_memory')
    expect(evaluation(subject)).toBe(true)
    jest.spyOn(Date, 'now').mockReturnValue((vector.now + 301) * 1000)
    expect(evaluation(subject)).toBe(false)
    expect(events('signing.expired')[0].details.action).toBe('runtime_default_until_verified_refresh')
    expect(events('evaluation.completed').slice(-1)[0].details.expirationPolicy).toBe('verified_proof_expiry')
  })
})
