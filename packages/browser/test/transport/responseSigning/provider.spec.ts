import { createPrivateKey, sign, webcrypto } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import { TextDecoder, TextEncoder } from 'node:util'
import { ErrorCode, OpenFeature, ProviderEvents, ProviderStatus, StandardResolutionReasons } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../../src/domain/configuration'
import { DatadogProvider } from '../../../src/openfeature/provider'
import {
  createFlagsConfigurationFetcher,
  fetchPrecomputedConfiguration,
} from '../../../src/transport/fetchConfiguration'
import { createResponseSigningController, signingContextKey } from '../../../src/transport/responseSigning/controller'
import {
  buildSigningTranscript,
  decodeBase64,
  MAX_SIGNED_RESPONSE,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION_HEADER,
} from '../../../src/transport/responseSigning/verification'
import corpus from '../../ffe-response-signing-data/response-signing/v1/corpus.json'

const vector = corpus.cases[0]
const roots = [corpus.anchor_der_base64]
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
const defaultOptions: FlaggingInitConfiguration = {
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
    responseSigning: { mode, trustedRootCertificates: roots },
    ...extra,
  })
  providers.push(result)
  return result
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
  issuedAt = vector.now
): Promise<Response> {
  const headers = new Headers(vector.response.headers as [string, string][])
  headers.set('x-datadog-feature-flags-issued-at', String(issuedAt))
  headers.set('x-datadog-feature-flags-expires-at', String(issuedAt + 300))
  const body = new TextEncoder().encode(JSON.stringify(payload(value)))
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
    decodeBase64(headers.get('x-datadog-feature-flags-signing-intermediate')!, 4096)
  )
  const key = createPrivateKey({
    key: Buffer.from(vector.credential!.private_key_pkcs8_der_base64, 'base64'),
    type: 'pkcs8',
    format: 'der',
  })
  headers.set('x-datadog-feature-flags-signature', sign('sha256', Buffer.from(transcript), key).toString('base64'))
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
test('required needs an explicit local anchor before any network operation', () => {
  expect(() => provider('required', { responseSigning: { mode: 'required' } })).toThrow('locally trusted root')
})
test('staging selects its root only when signing is enabled', () => {
  expect(createResponseSigningController(undefined, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'off' }, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })).toBeDefined()
  expect(() =>
    createResponseSigningController({ mode: 'required', trustedRootCertificates: [] }, { site: 'datad0g.com' })
  ).toThrow('locally trusted root')
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
      responseSigning: { mode: 'required' },
    })
  ).toThrow('locally trusted root')
})
test('the effective staging endpoint overrides a production site for root selection', () => {
  const subject = provider('required', {
    site: 'datadoghq.com',
    flaggingProxy: 'https://preview.ff-cdn.datad0g.com/precompute-assignments',
    responseSigning: { mode: 'required' },
  })
  expect(subject).toBeDefined()
})
test('automatic trust cannot be reused for a different request origin', () => {
  const signing = createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })!
  expect(() => signing.prepare('https://proxy.test/assign', {}, '{}')).toThrow('unsupported-request')
})
test.each(['provider', 'fetch', 'factory'] as const)(
  '%s selects staging trust from the resolved endpoint without another option',
  async (entry) => {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    const options = {
      ...defaultOptions,
      site: 'datad0g.com' as const,
      env: 'staging',
      responseSigning: { mode: 'observe' as const },
    }
    if (entry === 'provider') await provider('observe', options).initialize(context)
    else if (entry === 'factory') await createFlagsConfigurationFetcher(options)(context)
    else await fetchPrecomputedConfiguration({ ...options, context })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers).get(SIGNING_VERSION_HEADER)).toBe('1')
  }
)
test.each(['provider', 'fetch', 'factory'] as const)(
  '%s uses the proxy destination even when site is production',
  async (entry) => {
    global.fetch = jest.fn().mockResolvedValue(unsigned())
    const options = {
      ...defaultOptions,
      site: 'datadoghq.com' as const,
      env: 'staging',
      flaggingProxy: 'https://preview.ff-cdn.datad0g.com/precompute-assignments',
      responseSigning: { mode: 'observe' as const },
    }
    if (entry === 'provider') await provider('observe', options).initialize(context)
    else if (entry === 'factory') await createFlagsConfigurationFetcher(options)(context)
    else await fetchPrecomputedConfiguration({ ...options, context })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('https://preview.ff-cdn.datad0g.com/')
  }
)
test('the standalone fetcher honors a proxy override when selecting trust', () => {
  expect(() =>
    createFlagsConfigurationFetcher({
      ...defaultOptions,
      site: 'datad0g.com',
      flaggingProxy: 'https://proxy.test/assign',
      responseSigning: { mode: 'required' },
    })
  ).toThrow('locally trusted root')
})
test.each(['observe', 'required'] as const)(
  '%s verifies the actual normalized request, token override, query and response before provider admission',
  async (mode) => {
    global.fetch = jest.fn(signed)
    const subject = provider(mode, {
      customHeaders: { 'dd-client-token': 'effective-token' },
      flaggingProxy: 'https://proxy.test/assign?marker=a%2Fb',
      responseSigning: { mode, trustedRootCertificates: roots },
    })
    await subject.initialize(context)
    expect(evaluation(subject)).toBe(true)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain('marker=a%2Fb&dd_env=production')
    expect(new Headers(init.headers).get('dd-client-token')).toBe('effective-token')
    expect(new Headers(init.headers).get(SIGNING_NONCE_HEADER)).toMatch(/^[0-9a-f]{32}$/)
    expect(new Headers(init.headers).get(SIGNING_VERSION_HEADER)).toBe('1')
    expect(new Headers(init.headers).get('x-stream')).toBe('false')
    expect(new Headers(init.headers).get('x-dd-feature-flags-capabilities')?.split(',')).toContain(
      'response-signing-v1'
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(DatadogProvider.responseSigningVersion).toBe(1)
    expect(init.redirect).toBe('error')
  }
)
test('observe accepts unsigned and tampered ordinary responses without evaluation errors', async () => {
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const subject = provider('observe', {
    responseSigning: { mode: 'observe', trustedRootCertificates: roots },
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
})
test.each([401, 403, 500])('observe does not turn HTTP %i into a signing success', async (status) => {
  global.fetch = jest.fn().mockResolvedValue(response('{}', new Headers(), status))
  const subject = provider('observe', {
    responseSigning: { mode: 'observe', trustedRootCertificates: roots },
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
  expect(global.fetch).toHaveBeenCalledTimes(1)
  global.fetch = jest.fn(async (url, init) => {
    const valid = await signed(String(url), init!)
    return response(JSON.stringify(payload(false)), valid.headers)
  })
  await expect(provider('required').initialize(context)).rejects.toThrow('invalid-signature')
  expect(global.fetch).toHaveBeenCalledTimes(1)
})
test('required uses matching verified memory until original expiry, including every evaluation', async () => {
  global.fetch = jest.fn(signed)
  const subject = provider('required')
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
  '%s proof expiry: evaluation and OpenFeature lifecycle signals',
  async (mode) => {
    global.fetch = jest.fn(signed)
    const subject = provider(mode, {
      responseSigning: { mode, trustedRootCertificates: roots },
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
    const requestsAfterAdmission = (global.fetch as jest.Mock).mock.calls.length

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
            errorMessage: 'The verified flag configuration proof has expired',
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
          message: 'The verified flag configuration proof has expired',
        })
      )
    }
    expect(changed).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledTimes(requestsAfterAdmission)

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
test('OpenFeature clients receive expiry errors and recovery events', async () => {
  const domain = 'response-signing-expiry'
  const subject = provider('required')
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
        errorMessage: 'The verified flag configuration proof has expired',
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

test('expiry does not overwrite an in-flight context reconciliation', async () => {
  const subject = provider('required')
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
    errorMessage: 'The verified flag configuration proof has expired',
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
test('public v1 persistence is isolated from prototype signing cache namespaces', async () => {
  const signing = createResponseSigningController({ mode: 'observe', trustedRootCertificates: roots })!
  const namespace = await signing.cacheNamespace()
  expect(namespace).toMatch(/^response-signing-v1-[0-9a-f]{64}$/)
  const prototypeScope = JSON.stringify({ version: 3, mode: 'observe', roots, scope: {} })
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
      responseSigning: { mode: 'required', trustedRootCertificates: roots },
    })
  ).resolves.toHaveProperty('precomputed')
  const signing = createResponseSigningController({ mode: 'required', trustedRootCertificates: roots })!
  expect(() => signing.prepare('http://example.test/', { 'dd-client-token': 'test' }, '{}')).toThrow(
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
      responseSigning: { mode: 'required', trustedRootCertificates: roots },
    })
  ).resolves.toHaveProperty('precomputed')
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

test('observe retains network availability without WebCrypto; required fails before fetch', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const observer = provider('observe', { responseSigning: { mode: 'observe' } })
  await observer.initialize(context)
  expect(evaluation(observer)).toBe(true)
  expect(new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers).get(SIGNING_VERSION_HEADER)).toBeNull()
  ;(global.fetch as jest.Mock).mockClear()
  await expect(provider('required').initialize(context)).rejects.toThrow('unavailable-crypto')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('observe without a provisioned anchor accepts responses and required never promotes its cached entry', async () => {
  global.fetch = jest.fn(signed)
  const observer = provider('observe', { responseSigning: { mode: 'observe' } })
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

test('required refuses its verified memory after the clock moves backward', async () => {
  global.fetch = jest.fn(signed)
  const subject = provider('required')
  await subject.initialize(context)
  jest.spyOn(Date, 'now').mockReturnValue((vector.now - 1) * 1000)
  expect(evaluation(subject)).toBe(false)
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
    responseSigning: { mode: 'required', trustedRootCertificates: roots },
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
        responseSigning: { mode, trustedRootCertificates: roots },
      })
    ).rejects.toThrow('redirects')
    expect(global.fetch).toHaveBeenCalledTimes(1)
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
      responseSigning: { mode: 'observe' },
    })
  ).rejects.toThrow('redirects')
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

test('invalid ordinary configuration cannot downgrade required mode or admit bootstrap data', () => {
  const initialFlagsConfiguration = { precomputed: { response: payload(), context, fetchedAt: 1 as any } }
  for (const trustedRootCertificates of [roots, []]) {
    expect(() =>
      provider('required', {
        clientToken: '',
        initialFlagsConfiguration: initialFlagsConfiguration as any,
        responseSigning: { mode: 'required', trustedRootCertificates },
      })
    ).toThrow('valid provider configuration')
  }
})

describe('required response stream reads', () => {
  function setup() {
    const signing = createResponseSigningController({
      mode: 'required',
      trustedRootCertificates: roots,
    })!
    const request = signing.prepare('https://example.test/assign', { 'dd-client-token': 'test' }, '{}')!
    return { signing, request }
  }

  function streamed(body: ReadableStream<Uint8Array>, headers = new Headers()): Response {
    return { ...response('', headers), body } as unknown as Response
  }

  test.each([false, true])('rejects overflow and handles cancellation (rejects: %s)', async (rejectCancel) => {
    const { signing, request } = setup()
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
    const { signing, request } = setup()
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
    const { signing, request } = setup()
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
          responseSigning: { mode, trustedRootCertificates: roots },
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
        responseSigning: { mode, trustedRootCertificates: roots },
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

test.each(['missing-proof', 'invalid-signature', 'response-too-large'])(
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
      message: `Response signing: ${reason}`,
    })
    await flush()
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: ErrorCode.GENERAL,
        message: `Response signing: ${reason}`,
      })
    )
    expect(subject.resolveBooleanEvaluation('critical', false, {}, logger)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: `Response signing: ${reason}`,
    })
    global.fetch = jest.fn(signed)
    await subject.onContextChange(context, context)
    const recovered = subject.resolveBooleanEvaluation('critical', false, {}, logger)
    expect(recovered).toMatchObject({ value: true, reason: StandardResolutionReasons.TARGETING_MATCH })
    expect(recovered.errorCode).toBeUndefined()
    expect(recovered.errorMessage).toBeUndefined()
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
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: ErrorCode.GENERAL,
        message: 'Response signing: missing-proof',
      })
    )
    expect(client.getBooleanDetails('critical', false)).toMatchObject({
      value: false,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.GENERAL,
      errorMessage: 'Response signing: missing-proof',
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
        responseSigning: { mode: 'required', trustedRootCertificates: roots },
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
      'Response signing: missing-proof'
    )
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: ErrorCode.GENERAL,
        message: 'Response signing: missing-proof',
      })
    )
  })

  test('signed transport parsing errors do not expose echoed assignment credentials', async () => {
    const token = 'assignment.jwt.signature'
    global.fetch = jest.fn().mockResolvedValue(response(`invalid JSON ${token}`))
    await expect(
      fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context: { ...context, dd_assignment_token: token },
        responseSigning: { mode: 'observe', trustedRootCertificates: roots },
      })
    ).rejects.toThrow('Assignment response is not valid JSON')
  })
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
    const subject = provider('required', { debugMode: true })
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
