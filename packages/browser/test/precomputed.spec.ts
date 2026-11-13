import { createPrivateKey, sign, webcrypto } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import { type Client, type JsonValue, OpenFeature } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import { DatadogProvider } from '../src/openfeature/provider'
import { buildSigningTranscript, decodeBase64 } from '../src/transport/responseSigning/verification'
import corpus from './ffe-response-signing-data/response-signing/v1/corpus.json'
import { responseBody } from './precomputed-fixtures'

interface Filters {
  _include?: { platform: string }[]
  _skip?: { platform: string }[]
}
interface Evaluation extends Filters {
  flag: string
  variationType: string
  defaultValue: JsonValue
  expectedResult: { value: JsonValue; reason?: string; errorCode?: string | null; variantKey?: string | null }
}
interface Matcher extends Filters {
  _count: number
  [key: string]: unknown
}
interface Fixture extends Filters {
  name: string
  context: { targetingKey: string | null; attributes: Record<string, JsonValue> }
  evaluations: Evaluation[]
  expectedResponseError?: string
  expectations: { noUnmatchedEvents?: boolean; exposures?: Matcher[]; evaluationEvents?: Matcher[] }
}
const root = join(__dirname, 'ffe-response-signing-data/precomputed-assignments')
function discover(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? discover(path) : entry.name.endsWith('.json') ? [path] : []
    })
    .sort()
}
function applies(value: Filters): boolean {
  return (
    !value._skip?.some((item) => item.platform === 'web') &&
    (!value._include || value._include.some((item) => item.platform === 'web'))
  )
}
const files = discover(join(root, 'cases'))
if (!files.length) throw new Error('The shared precompute corpus is empty')
const cases = files.map((path) => ({ path, fixture: JSON.parse(readFileSync(path, 'utf8')) as Fixture }))
const vector = corpus.cases[0]
const key = createPrivateKey({
  key: Buffer.from(vector.credential!.private_key_pkcs8_der_base64, 'base64'),
  type: 'pkcs8',
  format: 'der',
})
const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
const previousFetch = global.fetch
function bytes(value: ArrayBuffer | ArrayBufferView): Buffer<ArrayBuffer> {
  return ArrayBuffer.isView(value)
    ? Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    : Buffer.from(new Uint8Array(value))
}
// jsdom buffers use a different realm. Cryptographic operations remain native WebCrypto.
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
function response(body: string, headers = new Headers()): Response {
  const data = new TextEncoder().encode(body)
  return {
    ok: true,
    status: 200,
    headers,
    redirected: false,
    body: null,
    arrayBuffer: async () => data.buffer,
    json: async () => JSON.parse(body),
  } as Response
}
async function signedResponse(url: RequestInfo | URL, init: RequestInit, body: string): Promise<Response> {
  const headers = new Headers(vector.response.headers as [string, string][])
  const transcript = await buildSigningTranscript(
    {
      url: String(url),
      method: 'POST',
      headers: new Headers(init.headers),
      body: new TextEncoder().encode(init.body as string),
    },
    { status: 200, headers, body: new TextEncoder().encode(body) },
    vector.now,
    vector.now + 300,
    decodeBase64(headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
    decodeBase64(headers.get('x-datadog-feature-flags-signing-intermediate')!, 4096)
  )
  headers.set('x-datadog-feature-flags-signature', sign('sha256', Buffer.from(transcript), key).toString('base64'))
  return response(body, headers)
}
function evaluate(client: Client, evaluation: Evaluation) {
  const { flag, defaultValue } = evaluation
  switch (evaluation.variationType) {
    case 'boolean':
      return client.getBooleanDetails(flag, defaultValue as boolean)
    case 'string':
      return client.getStringDetails(flag, defaultValue as string)
    case 'integer':
    case 'float':
      return client.getNumberDetails(flag, defaultValue as number)
    case 'object':
      return client.getObjectDetails(flag, defaultValue)
    default:
      throw new Error(`Unsupported getter: ${evaluation.variationType}`)
  }
}
function matches(event: unknown, fields: unknown): boolean {
  if (fields === null) return event == null
  if (typeof fields !== 'object') return event === fields
  if (Array.isArray(fields))
    return Array.isArray(event) && event.length === fields.length && fields.every((v, i) => matches(event[i], v))
  if (typeof event !== 'object' || event === null) return false
  return Object.entries(fields as Record<string, unknown>).every(([k, v]) =>
    matches((event as Record<string, unknown>)[k], v)
  )
}
function assertEvents(events: unknown[], matchers: Matcher[] = [], exact = false) {
  const remaining = [...events]
  for (const matcher of matchers.filter(applies)) {
    const fields = Object.fromEntries(Object.entries(matcher).filter(([key]) => !key.startsWith('_')))
    for (let i = 0; i < matcher._count; i++) {
      const index = remaining.findIndex((event) => matches(event, fields))
      expect({ fields, remaining, matched: index >= 0 }).toMatchObject({ matched: true })
      remaining.splice(index, 1)
    }
  }
  if (exact) expect(remaining).toEqual([])
}
beforeEach(() => {
  Object.assign(globalThis, { TextEncoder, TextDecoder })
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoBridge })
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
  jest.setSystemTime(vector.now * 1000)
})
afterEach(async () => {
  await OpenFeature.clearProviders()
  await OpenFeature.clearContext()
  global.fetch = previousFetch
  Object.defineProperty(globalThis, 'crypto', previousCrypto)
  jest.useRealTimers()
})
for (const mode of ['off', 'required'] as const) {
  describe(`shared precompute; signing ${mode}`, () => {
    for (const { path, fixture } of cases) {
      const run = applies(fixture) ? test : test.skip
      run(fixture.name, async () => {
        // Read the original numeric tokens directly from the pinned fixture.
        const body = responseBody(readFileSync(path, 'utf8'))
        const events: Record<string, unknown[]> = { exposures: [], flagevaluation: [] }
        global.fetch = jest.fn(async (url, init) => {
          if (String(url).includes('precompute-assignments')) {
            return mode === 'required' ? signedResponse(url, init!, body) : response(body)
          }
          for (const kind of Object.keys(events)) {
            if (String(url).includes(`/${kind}`)) {
              events[kind].push(
                ...String(init?.body)
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line))
                  .filter((event) => event.type !== 'sdk_diagnostic')
              )
            }
          }
          return response('{}')
        })
        const provider = new DatadogProvider({
          clientToken: 'shared-precompute-token',
          applicationId: 'shared-precompute',
          env: 'test',
          enableRumFeatureFlagTracking: false,
          responseSigning: { mode, trustedRootCertificates: [corpus.anchor_der_base64] },
        })
        const context = {
          ...fixture.context.attributes,
          ...(fixture.context.targetingKey === null ? {} : { targetingKey: fixture.context.targetingKey }),
        }
        const ready = OpenFeature.setProviderAndWait('canonical', provider, context)
        if (fixture.expectedResponseError) {
          expect(fixture.expectedResponseError).toBe('INVALID_RESPONSE')
          await expect(ready).rejects.toMatchObject({ code: 'PARSE_ERROR' })
        } else {
          await ready
          const client = OpenFeature.getClient('canonical')
          for (const evaluation of fixture.evaluations.filter(applies)) {
            const actual = evaluate(client, evaluation)
            const expected = evaluation.expectedResult
            expect(actual.value).toEqual(expected.value)
            if ('reason' in expected) expect(actual.reason).toBe(expected.reason)
            if ('errorCode' in expected) expect(actual.errorCode ?? null).toBe(expected.errorCode)
            if ('variantKey' in expected) expect(actual.variant ?? null).toBe(expected.variantKey)
          }
        }
        await jest.advanceTimersByTimeAsync(31_000)
        assertEvents(events.exposures, fixture.expectations.exposures, fixture.expectations.noUnmatchedEvents)
        assertEvents(
          events.flagevaluation,
          fixture.expectations.evaluationEvents,
          fixture.expectations.noUnmatchedEvents
        )
      })
    }
  })
}

test.each(['missing-proof', 'invalid-signature'])(
  'required rejects a shared response with %s before installation',
  async (failure) => {
    const body = responseBody(readFileSync(join(root, 'cases/evaluator/all-types-success.json'), 'utf8'))
    global.fetch = jest.fn(async (url, init) => {
      if (failure === 'missing-proof') return response(body)
      const signed = await signedResponse(url, init!, body)
      return response(`${body} `, signed.headers)
    })
    const provider = new DatadogProvider({
      clientToken: 'canonical-negative-control',
      env: 'test',
      enableRumFeatureFlagTracking: false,
      enableExposureLogging: false,
      enableFlagEvaluationTracking: false,
      responseSigning: { mode: 'required', trustedRootCertificates: [corpus.anchor_der_base64] },
    })
    try {
      await expect(provider.initialize({ targetingKey: 'canonical' })).rejects.toMatchObject({
        code: 'GENERAL',
        message: `Response signing: ${failure}`,
      })
    } finally {
      await provider.onClose()
    }
  }
)
