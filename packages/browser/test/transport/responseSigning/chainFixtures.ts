/**
 * Certificate-chain test helpers for response signing v1.
 *
 * `../../data/response-signing/chain/` holds test credentials issued by a local test CA (credential JSON `version` 1) and the two
 * public test roots. The private keys are test-only. The transcript builder below is written separately
 * from the SDK and does not call it.
 */
import { createHash, createPrivateKey, type KeyObject, sign, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = join(__dirname, '../../data/response-signing/chain')

export const CREDENTIAL_NAMES = [
  'two-intermediates',
  'backup-root',
  'rotated-lower-intermediate',
  'other-product',
  'missing-upper-intermediate',
  'one-intermediate',
  'codesigning-leaf',
  'unrelated-root',
] as const
export type CredentialName = (typeof CREDENTIAL_NAMES)[number]

export interface Credential {
  privateKey: KeyObject
  leafBase64: string
  intermediatesBase64: string[]
}

export function loadCredential(name: CredentialName): Credential {
  const json = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8')) as {
    version: number
    private_key_pkcs8_der_base64: string
    certificate_der_base64: string
    intermediates_der_base64: string[]
  }
  if (json.version !== 1) throw new Error(`unexpected credential version in ${name}`)
  return {
    privateKey: createPrivateKey({
      key: Buffer.from(json.private_key_pkcs8_der_base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    }),
    leafBase64: json.certificate_der_base64,
    intermediatesBase64: json.intermediates_der_base64,
  }
}

function pemToBase64(pem: string): string {
  return pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim()
}
export const ROOT_A = pemToBase64(readFileSync(join(directory, 'root-a.pem'), 'utf8'))
export const ROOT_B = pemToBase64(readFileSync(join(directory, 'root-b.pem'), 'utf8'))

/**
 * A `now` inside every fixture leaf's validity: one hour after the latest leaf notBefore.
 * Leaves are valid for 72 hours, so this stays valid when the fixtures are refreshed together.
 */
export const FIXTURE_NOW = (() => {
  const latest = Math.max(
    ...CREDENTIAL_NAMES.map((name) =>
      Date.parse(new X509Certificate(Buffer.from(loadCredential(name).leafBase64, 'base64')).validFrom)
    )
  )
  return Math.floor(latest / 1000) + 3600
})()

const OPTIONAL_HEADERS = [
  'content-type',
  'dd-application-id',
  'x-rkyv',
  'x-use-cache',
  'x-dd-feature-flags-capabilities',
]
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest()
const u = (value: number, width: number) => {
  const bytes = Buffer.alloc(width)
  bytes.writeUIntBE(value, width - Math.min(width, 6), Math.min(width, 6))
  return bytes
}
const lp = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  return Buffer.concat([u(bytes.length, 4), bytes])
}

/** Lowercase host, IPv6 in brackets, and the port only when it is not 443. */
function authority(url: URL): string {
  const port = url.port === '' || url.port === '443' ? '' : `:${url.port}`
  return `${url.hostname.toLowerCase()}${port}`
}

/** Independent v1 transcript with the certificate-chain tail. */
export function expectedTranscript(
  request: { url: string; method: string; headers: Headers; body: Uint8Array },
  response: { status: number; body: Uint8Array },
  issuedAt: number,
  expiresAt: number,
  leaf: Uint8Array,
  intermediates: Uint8Array[],
  minimumNotBefore?: number
): Buffer {
  const url = new URL(request.url)
  const parts: Buffer[] = [
    Buffer.from('datadog.feature-flags.precomputed-assignments.v1\0', 'utf8'),
    lp(request.method),
    lp('https'),
    lp(authority(url)),
    lp(url.pathname),
    lp(url.search),
    lp(Buffer.from(request.headers.get('x-datadog-feature-flags-request-nonce')!, 'hex')),
    sha(request.body),
    sha(request.headers.get('dd-client-token')!),
  ]
  for (const name of OPTIONAL_HEADERS) {
    const value = request.headers.get(name)
    parts.push(Buffer.from([value === null ? 0 : 1]))
    if (value !== null) parts.push(lp(value))
  }
  const auth = request.headers.get('authorization')
  parts.push(Buffer.from([auth === null ? 0 : 1]))
  if (auth !== null) parts.push(sha(auth))
  parts.push(
    u(response.status, 2),
    u(issuedAt, 8),
    u(expiresAt, 8),
    u(response.body.length, 8),
    sha(response.body),
    sha(leaf),
    Buffer.from([intermediates.length]),
    ...intermediates.map(sha)
  )
  // DRAFT minimum not-before tail: u8(1) || u64be(value), only when the header is present.
  if (minimumNotBefore !== undefined) parts.push(Buffer.from([1]), u(minimumNotBefore, 8))
  return Buffer.concat(parts)
}

export function signingRequest(url = 'https://assignments.example.test/precompute-assignments?dd_env=fixture-env') {
  return {
    url,
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/vnd.api+json',
      'dd-client-token': 'fixture-token',
      'x-dd-feature-flags-capabilities': 'response-signing-v1',
      'x-datadog-feature-flags-signature-version': '1',
      'x-datadog-feature-flags-request-nonce': '00112233445566778899aabbccddeeff',
    }),
    body: new Uint8Array(Buffer.from('{"data":{"type":"precompute-assignments-request"}}')),
  }
}

/** Sign a synthetic 200 response with the edge's v1 proof headers. */
export function signedResponse(
  request: { url: string; method: string; headers: Headers; body: Uint8Array },
  signer: { privateKey: KeyObject; leafBase64: string; intermediatesBase64: string[] },
  now = FIXTURE_NOW,
  body: Uint8Array = new Uint8Array(Buffer.from('{"data":{"attributes":{"flags":{}}}}')),
  minimumNotBefore?: number
) {
  const leaf = Buffer.from(signer.leafBase64, 'base64')
  const intermediates = signer.intermediatesBase64.map((value) => Buffer.from(value, 'base64'))
  const issuedAt = now,
    expiresAt = now + 300
  const transcript = expectedTranscript(
    request,
    { status: 200, body },
    issuedAt,
    expiresAt,
    leaf,
    intermediates,
    minimumNotBefore
  )
  const headers = new Headers({
    'content-type': 'application/json',
    'x-datadog-feature-flags-signature-version': '1',
    'x-datadog-feature-flags-signing-certificate': signer.leafBase64,
    'x-datadog-feature-flags-signing-chain': signer.intermediatesBase64.join(','),
    'x-datadog-feature-flags-certificate-id': sha(leaf).toString('hex'),
    'x-datadog-feature-flags-issued-at': String(issuedAt),
    'x-datadog-feature-flags-expires-at': String(expiresAt),
    'x-datadog-feature-flags-signature': sign('sha256', transcript, signer.privateKey).toString('base64'),
  })
  if (minimumNotBefore !== undefined)
    headers.set('x-datadog-feature-flags-minimum-not-before', String(minimumNotBefore))
  return { status: 200, headers, body, transcript, issuedAt, expiresAt }
}
