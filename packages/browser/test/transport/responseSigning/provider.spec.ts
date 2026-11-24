import { createPrivateKey, sign, webcrypto } from 'node:crypto'
import { ReadableStream } from 'node:stream/web'
import { TextDecoder, TextEncoder } from 'node:util'
import { evaluatePrecomputedConfiguration, parsePrecomputedConfigurationResponse } from '@datadog/flagging-core'
import { DatadogProvider } from '../../../src/openfeature/provider'
import { createResponseSigningController, signingContextKey } from '../../../src/transport/responseSigning/controller'
import {
  buildSigningTranscript,
  decodeBase64,
  MAX_SIGNED_RESPONSE,
} from '../../../src/transport/responseSigning/verification'
import corpus from '../../ffe-response-signing-data/response-signing/v1/corpus.json'

const vector = corpus.cases[0]
const roots = [corpus.anchor_der_base64]
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
async function signed(
  url: RequestInfo | URL,
  init: RequestInit = {},
  value = true,
  issuedAt = vector.now,
  rawBody = JSON.stringify(payload(value))
): Promise<Response> {
  const headers = new Headers(vector.response.headers as [string, string][])
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
test('staging selects its root only when signing is enabled', () => {
  expect(createResponseSigningController(undefined, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'off' }, { site: 'datad0g.com' })).toBeUndefined()
  expect(createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })).toBeDefined()
  expect(() =>
    createResponseSigningController({ mode: 'required', trustedRootCertificates: [] }, { site: 'datad0g.com' })
  ).toThrow('locally trusted root')
})
test('automatic trust cannot be reused for a different request origin', () => {
  const signing = createResponseSigningController({ mode: 'required' }, { site: 'datad0g.com' })!
  expect(() => signing.prepare('https://proxy.test/assign', {}, '{}')).toThrow('unsupported-request')
})

test.each(['9007199254740993', '1e-999', '1e999'])(
  'retains numeric token %s when observe mode continues without a signing request',
  async (token) => {
    const signing = createResponseSigningController({ mode: 'observe', trustedRootCertificates: roots })!
    const request = signing.prepare(
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

  test.each(['9007199254740993', '1e-999', '1e999'])(
    'retains numeric token %s after successful verification',
    async (token) => {
      const { signing, request } = setup()
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
