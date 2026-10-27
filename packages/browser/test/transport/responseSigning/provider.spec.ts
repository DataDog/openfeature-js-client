import { createPrivateKey, sign, webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import { ProviderStatus } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../../src/domain/configuration'
import { DatadogProvider } from '../../../src/openfeature/provider'
import { fetchPrecomputedConfiguration } from '../../../src/transport/fetchConfiguration'
import { createResponseSigningController } from '../../../src/transport/responseSigning/controller'
import {
  buildSigningTranscript,
  decodeBase64,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION_HEADER,
} from '../../../src/transport/responseSigning/verification'
import corpus from './corpus.json'

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
async function signed(url: RequestInfo | URL, init: RequestInit = {}, value = true): Promise<Response> {
  const headers = new Headers(vector.response.headers as [string, string][])
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
    vector.now,
    vector.now + 300,
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
  expect(init.redirect).toBeUndefined()
  // Provider construction retains its existing tracking UUID generation.
  expect(digest).not.toHaveBeenCalled()
  expect(evaluation(subject)).toBe(true)
})
test('required needs an explicit local anchor before any network operation', () => {
  expect(() => provider('required', { responseSigning: { mode: 'required' } })).toThrow('locally trusted root')
})
test.each(['observe', 'required'] as const)(
  '%s verifies the actual normalized request, token override, query and response before provider admission',
  async (mode) => {
    const outcomes = jest.fn()
    global.fetch = jest.fn(signed)
    const subject = provider(mode, {
      customHeaders: { 'dd-client-token': 'effective-token' },
      flaggingProxy: 'https://proxy.test/assign?marker=a%2Fb',
      responseSigning: { mode, trustedRootCertificates: roots, onVerification: outcomes },
    })
    await subject.initialize(context)
    expect(evaluation(subject)).toBe(true)
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain('marker=a%2Fb&dd_env=production')
    expect(new Headers(init.headers).get('dd-client-token')).toBe('effective-token')
    expect(new Headers(init.headers).get(SIGNING_NONCE_HEADER)).toMatch(/^[0-9a-f]{32}$/)
    expect(init.redirect).toBe('error')
    expect(outcomes).toHaveBeenCalledWith({ status: 'verified' })
  }
)
test('observe accepts unsigned and tampered ordinary responses with bounded diagnostics', async () => {
  const outcomes = jest.fn()
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const subject = provider('observe', {
    responseSigning: { mode: 'observe', trustedRootCertificates: roots, onVerification: outcomes },
  })
  await subject.initialize(context)
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(true)
  expect(outcomes).toHaveBeenCalledTimes(1)
  expect(outcomes).toHaveBeenCalledWith({ status: 'unverified', reason: 'missing-proof' })
  global.fetch = jest.fn(async (url, init) => {
    const valid = await signed(String(url), init!)
    return response(JSON.stringify(payload(false)), valid.headers)
  })
  await subject.onContextChange(context, context)
  expect(evaluation(subject)).toBe(false)
  expect(outcomes).toHaveBeenLastCalledWith({ status: 'unverified', reason: 'invalid-signature' })
})
test.each([401, 403, 500])('observe does not turn HTTP %i into a signing success', async (status) => {
  const outcomes = jest.fn()
  global.fetch = jest.fn().mockResolvedValue(response('{}', new Headers(), status))
  const subject = provider('observe', {
    responseSigning: { mode: 'observe', trustedRootCertificates: roots, onVerification: outcomes },
  })
  await expect(subject.initialize(context)).rejects.toThrow('Failed to fetch flag configuration')
  expect(outcomes).not.toHaveBeenCalled()
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

test('observe retains network availability without WebCrypto; required fails before fetch', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
  global.fetch = jest.fn().mockResolvedValue(unsigned())
  const outcomes = jest.fn()
  const observer = provider('observe', { responseSigning: { mode: 'observe', onVerification: outcomes } })
  await observer.initialize(context)
  expect(evaluation(observer)).toBe(true)
  expect(outcomes).toHaveBeenCalledWith({ status: 'unverified', reason: 'unavailable-crypto' })
  expect(new Headers((global.fetch as jest.Mock).mock.calls[0][1].headers).get(SIGNING_VERSION_HEADER)).toBeNull()
  ;(global.fetch as jest.Mock).mockClear()
  await expect(provider('required').initialize(context)).rejects.toThrow('unavailable-crypto')
  expect(global.fetch).not.toHaveBeenCalled()
})

test('observe without a provisioned anchor reports unverified and required never promotes its cached entry', async () => {
  global.fetch = jest.fn(signed)
  const outcomes = jest.fn()
  const observer = provider('observe', { responseSigning: { mode: 'observe', onVerification: outcomes } })
  await observer.initialize(context)
  expect(evaluation(observer)).toBe(true)
  expect(outcomes).toHaveBeenCalledWith({ status: 'unverified', reason: 'missing-anchor' })
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
    const outcomes = jest.fn()
    await expect(
      fetchPrecomputedConfiguration({
        ...defaultOptions,
        env: 'production',
        context,
        responseSigning: { mode, trustedRootCertificates: roots, onVerification: outcomes },
      })
    ).rejects.toThrow('redirects')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(outcomes).not.toHaveBeenCalled()
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
