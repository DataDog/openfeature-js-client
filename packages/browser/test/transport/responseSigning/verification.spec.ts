/** @jest-environment node */
/**
 * Coordinator-pinned synthetic corpus, response-signing-v3-1.
 * Authority: reviewed FFE LEAN KB implementation profile (model status: not_modeled).
 * corpus.json SHA256 cc444ec8a2890430fa8dd8aee6cbde5a92d388ee55938596aac67891cfc099b6.
 * 43 response cases: 6 accepts, 37 rejects. Two server-only private-key cases are excluded by profile.
 */
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder, TextEncoder } from 'node:util'
import {
  buildSigningTranscript,
  decodeBase64,
  sha256,
  verifyResponse,
} from '../../../src/transport/responseSigning/verification'

const raw = readFileSync(join(__dirname, 'corpus.json'))
const corpus = JSON.parse(raw.toString()) as {
  anchor_der_base64: string
  cases: Array<{
    id: string
    now: number
    expected_accept: boolean
    transcript_base64?: string
    request: { url: string; method: string; headers: [string, string][]; body_base64: string }
    response: { status: number; headers: [string, string][]; body_base64: string }
  }>
}
const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  Object.assign(globalThis, { TextEncoder, TextDecoder })
})
afterAll(() => Object.defineProperty(globalThis, 'crypto', previousCrypto))

test('the independent corpus and applicability counts are unchanged', () => {
  expect(createHash('sha256').update(raw).digest('hex')).toBe(
    'cc444ec8a2890430fa8dd8aee6cbde5a92d388ee55938596aac67891cfc099b6'
  )
  expect(corpus.cases).toHaveLength(43)
  expect(corpus.cases.filter((c) => c.expected_accept)).toHaveLength(6)
})
test.each(corpus.cases)('$id', async (vector) => {
  const request = {
    ...vector.request,
    headers: new Headers(vector.request.headers),
    body: decodeBase64(vector.request.body_base64, 1024 * 1024),
  }
  const response = {
    ...vector.response,
    headers: new Headers(vector.response.headers),
    body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
  }
  if (vector.expected_accept) {
    await expect(verifyResponse(request, response, [corpus.anchor_der_base64], vector.now)).resolves.toEqual({
      expiresAt: Number(response.headers.get('x-datadog-feature-flags-expires-at')),
      verifiedAt: vector.now,
    })
    const transcript = await buildSigningTranscript(
      request,
      response,
      Number(response.headers.get('x-datadog-feature-flags-issued-at')),
      Number(response.headers.get('x-datadog-feature-flags-expires-at')),
      decodeBase64(response.headers.get('x-datadog-feature-flags-signing-certificate')!, 4096),
      decodeBase64(response.headers.get('x-datadog-feature-flags-signing-intermediate')!, 4096)
    )
    expect(Buffer.from(transcript).toString('base64')).toBe(vector.transcript_base64)
  } else {
    await expect(verifyResponse(request, response, [corpus.anchor_der_base64], vector.now)).rejects.toThrow()
  }
})

// Buffer.slice is a view, unlike Uint8Array.slice. Crypto must receive exactly the logical bytes.
test('hashes exactly the supplied view, including a Buffer subclass', async () => {
  const input = Buffer.from('prefix-exact-suffix').subarray(7, 12)
  expect(Buffer.from(await sha256(input)).toString('hex')).toBe(createHash('sha256').update('exact').digest('hex'))
})

// Independent reviewer regression: X.690 11.2.2 requires minimal encoding of named-bit lists.
// Public-only synthetic chains/proofs; the original pinned 43-case corpus remains unchanged.
const keyUsageRaw = readFileSync(join(__dirname, 'key-usage-supplement.json'))
const keyUsageSupplement = JSON.parse(keyUsageRaw.toString()) as { anchor: string; cases: typeof corpus.cases }
test('the independently reviewed KeyUsage supplemental oracle is unchanged', () => {
  expect(createHash('sha256').update(keyUsageRaw).digest('hex')).toBe(
    'e6e2bc29ab28b490a1e17bb7c46a9342cf9496d9962c04aa5ca0e3ce6b08d347'
  )
})
test.each(keyUsageSupplement.cases)('canonical DER control: $id', async (vector) => {
  const request = {
    ...vector.request,
    headers: new Headers(vector.request.headers),
    body: decodeBase64(vector.request.body_base64, 1024 * 1024),
  }
  const response = {
    ...vector.response,
    headers: new Headers(vector.response.headers),
    body: decodeBase64(vector.response.body_base64, 2 * 1024 * 1024),
  }
  const result = verifyResponse(request, response, [keyUsageSupplement.anchor], vector.now)
  if (vector.expected_accept) await expect(result).resolves.toHaveProperty('expiresAt')
  else await expect(result).rejects.toThrow('invalid-certificate')
})
