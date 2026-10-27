import { AsnConvert } from '@peculiar/asn1-schema'
import {
  AuthorityKeyIdentifier,
  BasicConstraints,
  Certificate,
  ExtendedKeyUsage,
  KeyUsage,
  SubjectKeyIdentifier,
} from '@peculiar/asn1-x509'

export const SIGNING_VERSION_HEADER = 'x-datadog-feature-flags-signature-version'
export const SIGNING_NONCE_HEADER = 'x-datadog-feature-flags-request-nonce'
export const SIGNING_CAPABILITY = 'response-signing-v3'
const PREFIX = 'x-datadog-feature-flags-'
const MAX_CERTIFICATE = 4096
export const MAX_SIGNED_REQUEST = 1024 * 1024
export const MAX_SIGNED_RESPONSE = 2 * 1024 * 1024
const CODE_SIGNING = '1.3.6.1.5.5.7.3.3'
const ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const P256_PARAMETERS = new Uint8Array([6, 8, 42, 134, 72, 206, 61, 3, 1, 7])
const OPTIONAL_HEADERS = [
  'content-type',
  'dd-application-id',
  'x-rkyv',
  'x-use-cache',
  'x-dd-feature-flags-capabilities',
]

export type VerificationFailure =
  | 'unsupported-request'
  | 'unavailable-crypto'
  | 'missing-anchor'
  | 'missing-proof'
  | 'invalid-proof'
  | 'response-too-large'
  | 'invalid-certificate'
  | 'invalid-signature'
  | 'expired-proof'

export interface SigningRequest {
  url: string
  method: string
  headers: Headers
  body: Uint8Array
}
export interface SigningResponse {
  status: number
  headers: Headers
  body: Uint8Array
}
export interface VerifiedResponse {
  verifiedAt: number
  expiresAt: number
}

// Errors contain only fixed diagnostic codes, never request or certificate contents.
export class ResponseVerificationError extends Error {
  constructor(readonly reason: VerificationFailure) {
    super(`Response signing: ${reason}`)
    this.name = 'ResponseVerificationError'
  }
}
function requireCondition(condition: unknown, reason: VerificationFailure = 'invalid-proof'): asserts condition {
  if (!condition) throw new ResponseVerificationError(reason)
}
export function cryptoProvider(): Crypto {
  requireCondition(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues, 'unavailable-crypto')
  return globalThis.crypto
}
export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await cryptoProvider().subtle.digest('SHA-256', buffer(bytes)))
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
function equal(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b)
  return aa.length === bb.length && aa.every((value, index) => value === bb[index])
}
export function decodeBase64(value: string, maxBytes: number): Uint8Array {
  requireCondition(value.length > 0 && value.length <= 4 * Math.ceil(maxBytes / 3))
  requireCondition(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
  const raw = atob(value)
  requireCondition(raw.length <= maxBytes && btoa(raw) === value)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}
function proof(headers: Headers, name: string): string {
  const value = headers.get(PREFIX + name)
  requireCondition(value !== null && value.length > 0, 'missing-proof')
  requireCondition(value.length <= 4 * Math.ceil(MAX_CERTIFICATE / 3) && !value.includes(','))
  return value
}
function seconds(value: string): number {
  requireCondition(value.length <= 16 && /^(0|[1-9][0-9]*)$/.test(value))
  const result = Number(value)
  requireCondition(Number.isSafeInteger(result))
  return result
}

/** Bounded DER validation before the standard X.509 schema parser. Reject BER and nonminimal primitives. */
function checkDer(bytes: Uint8Array): void {
  let nodes = 0
  function read(start: number, limit: number, depth: number): number {
    requireCondition(depth <= 24 && ++nodes <= 512 && start + 2 <= limit, 'invalid-certificate')
    const tag = bytes[start++]
    requireCondition((tag & 31) !== 31, 'invalid-certificate')
    let length = bytes[start++]
    if (length & 128) {
      const count = length & 127
      requireCondition(count > 0 && count <= 3 && start + count <= limit && bytes[start] !== 0, 'invalid-certificate')
      length = 0
      for (let i = 0; i < count; i++) length = length * 256 + bytes[start++]
      requireCondition(length >= 128, 'invalid-certificate')
    }
    const end = start + length
    requireCondition(end <= limit, 'invalid-certificate')
    if (tag & 32) {
      // Only SEQUENCE/SET are constructed universal types in this restricted profile.
      requireCondition((tag & 192) !== 0 || tag === 48 || tag === 49, 'invalid-certificate')
      let previous: Uint8Array | undefined
      while (start < end) {
        const next = read(start, end, depth + 1)
        if (tag === 49) {
          const item = bytes.slice(start, next)
          if (previous) {
            let index = 0
            while (index < Math.min(previous.length, item.length) && previous[index] === item[index]) index++
            requireCondition(
              index === previous.length || (index < item.length && previous[index] < item[index]),
              'invalid-certificate'
            )
          }
          previous = item
        }
        start = next
      }
    } else if (tag === 1) {
      requireCondition(length === 1 && (bytes[start] === 0 || bytes[start] === 255), 'invalid-certificate')
    } else if (tag === 2) {
      requireCondition(
        length > 0 &&
          !(
            length > 1 &&
            ((bytes[start] === 0 && !(bytes[start + 1] & 128)) || (bytes[start] === 255 && bytes[start + 1] & 128))
          ),
        'invalid-certificate'
      )
    } else if (tag === 3) {
      const unused = bytes[start]
      requireCondition(
        length > 0 && unused <= 7 && (length > 1 || unused === 0) && (bytes[end - 1] & ((1 << unused) - 1)) === 0,
        'invalid-certificate'
      )
    } else if (tag === 5) {
      requireCondition(length === 0, 'invalid-certificate')
    } else if (tag === 6) {
      requireCondition(length > 0 && !(bytes[end - 1] & 128), 'invalid-certificate')
      for (let i = start; i < end; i++)
        requireCondition(bytes[i] !== 128 || (i > start && !!(bytes[i - 1] & 128)), 'invalid-certificate')
    } else if (tag === 23 || tag === 24) {
      const value = String.fromCharCode(...bytes.slice(start, end))
      requireCondition((tag === 23 ? /^[0-9]{12}Z$/ : /^[0-9]{14}Z$/).test(value), 'invalid-certificate')
      const full = tag === 23 ? (Number(value.slice(0, 2)) >= 50 ? '19' : '20') + value : value
      const date = new Date(
        `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`
      )
      requireCondition(
        Number.isFinite(date.getTime()) && date.toISOString().replace(/[-:T]/g, '').slice(0, 14) === full.slice(0, 14),
        'invalid-certificate'
      )
    }
    return end
  }
  requireCondition(read(0, bytes.length, 0) === bytes.length, 'invalid-certificate')
}
function parseDer<T>(bytes: Uint8Array, schema: new () => T): T {
  checkDer(bytes)
  const value = AsnConvert.parse(buffer(bytes), schema, {
    berOptions: { maxDepth: 24, maxNodes: 512, maxContentLength: MAX_CERTIFICATE },
  })
  requireCondition(equal(bytes, AsnConvert.serialize(value)), 'invalid-certificate')
  return value
}

/** Convert strictly minimal, positive P-256 DER integers to WebCrypto's fixed-width signature. */
export function ecdsaSignature(der: Uint8Array): Uint8Array {
  requireCondition(der.length >= 8 && der.length <= 72 && der[0] === 48 && der[1] === der.length - 2)
  const result = new Uint8Array(64)
  let offset = 2
  for (let part = 0; part < 2; part++) {
    requireCondition(der[offset++] === 2)
    let length = der[offset++]
    requireCondition(length >= 1 && length <= 33 && offset + length <= der.length && !(der[offset] & 128))
    if (der[offset] === 0) {
      requireCondition(length > 1 && !!(der[offset + 1] & 128))
      offset++
      length--
    }
    requireCondition(length <= 32 && der.slice(offset, offset + length).some((value) => value !== 0))
    result.set(der.slice(offset, offset + length), part * 32 + 32 - length)
    offset += length
  }
  requireCondition(offset === der.length)
  return result
}

interface ParsedCertificate {
  certificate: Certificate
  notBefore: number
  notAfter: number
  ski?: Uint8Array
  aki?: Uint8Array
}
function parseCertificate(der: Uint8Array, role: 'leaf' | 'intermediate' | 'anchor'): ParsedCertificate {
  try {
    checkDer(der)
    const certificate = AsnConvert.parse(buffer(der), Certificate, {
      berOptions: { maxDepth: 24, maxNodes: 512, maxContentLength: MAX_CERTIFICATE },
    })
    // The library preserves raw TBS bytes. Reconstruct without that shortcut so the full DER/schema is checked.
    requireCondition(
      equal(
        der,
        AsnConvert.serialize(
          new Certificate({
            tbsCertificate: certificate.tbsCertificate,
            signatureAlgorithm: certificate.signatureAlgorithm,
            signatureValue: certificate.signatureValue,
          })
        )
      ),
      'invalid-certificate'
    )
    const tbs = certificate.tbsCertificate
    requireCondition(
      tbs.version === 2 && tbs.issuerUniqueID === undefined && tbs.subjectUniqueID === undefined,
      'invalid-certificate'
    )
    for (const algorithm of [tbs.signature, certificate.signatureAlgorithm]) {
      requireCondition(
        algorithm.algorithm === ECDSA_SHA256 && algorithm.parameters === undefined,
        'invalid-certificate'
      )
    }
    const key = tbs.subjectPublicKeyInfo
    requireCondition(
      key.algorithm.algorithm === '1.2.840.10045.2.1' &&
        key.algorithm.parameters instanceof ArrayBuffer &&
        equal(key.algorithm.parameters, P256_PARAMETERS) &&
        key.subjectPublicKey.byteLength === 65 &&
        new Uint8Array(key.subjectPublicKey)[0] === 4,
      'invalid-certificate'
    )
    const notBefore = tbs.validity.notBefore.getTime().getTime() / 1000
    const notAfter = tbs.validity.notAfter.getTime().getTime() / 1000
    requireCondition(
      Number.isSafeInteger(notBefore) && Number.isSafeInteger(notAfter) && notBefore < notAfter,
      'invalid-certificate'
    )
    const extensions = new Map<string, NonNullable<typeof tbs.extensions>[number]>()
    for (const extension of tbs.extensions || []) {
      checkDer(new Uint8Array(extension.extnValue.buffer))
      requireCondition(!extensions.has(extension.extnID), 'invalid-certificate')
      requireCondition(!['2.5.29.30', '2.5.29.36', '2.5.29.54'].includes(extension.extnID), 'invalid-certificate')
      requireCondition(
        !extension.critical ||
          ['2.5.29.19', '2.5.29.15', '2.5.29.37', '2.5.29.14', '2.5.29.35'].includes(extension.extnID),
        'invalid-certificate'
      )
      extensions.set(extension.extnID, extension)
    }
    const basic = extensions.get('2.5.29.19'),
      usage = extensions.get('2.5.29.15'),
      eku = extensions.get('2.5.29.37')
    if (role !== 'anchor') {
      requireCondition(basic?.critical && usage?.critical, 'invalid-certificate')
      const constraints = parseDer(new Uint8Array(basic.extnValue.buffer), BasicConstraints)
      requireCondition(
        role === 'leaf'
          ? !constraints.cA && constraints.pathLenConstraint === undefined
          : constraints.cA && constraints.pathLenConstraint === 0,
        'invalid-certificate'
      )
      const keyUsageDer = new Uint8Array(usage.extnValue.buffer)
      // KeyUsage is a named-bit list: DER omits every trailing zero bit, not just zero padding within an octet.
      requireCondition(
        equal(keyUsageDer, new Uint8Array(role === 'leaf' ? [3, 2, 7, 128] : [3, 2, 1, 6])),
        'invalid-certificate'
      )
      const keyUsage = parseDer(keyUsageDer, KeyUsage)
      requireCondition(keyUsage.toNumber() === (role === 'leaf' ? 1 : 96), 'invalid-certificate')
      requireCondition(role !== 'leaf' || eku, 'invalid-certificate')
    }
    if (eku) {
      const purposes = parseDer(new Uint8Array(eku.extnValue.buffer), ExtendedKeyUsage)
      requireCondition(purposes.length === 1 && purposes[0] === CODE_SIGNING, 'invalid-certificate')
    }
    const skiExtension = extensions.get('2.5.29.14'),
      akiExtension = extensions.get('2.5.29.35')
    const ski = skiExtension
      ? new Uint8Array(parseDer(new Uint8Array(skiExtension.extnValue.buffer), SubjectKeyIdentifier).buffer)
      : undefined
    let aki: Uint8Array | undefined
    if (akiExtension) {
      const identifier = parseDer(new Uint8Array(akiExtension.extnValue.buffer), AuthorityKeyIdentifier)
      requireCondition(
        identifier.authorityCertIssuer === undefined && identifier.authorityCertSerialNumber === undefined,
        'invalid-certificate'
      )
      aki = identifier.keyIdentifier ? new Uint8Array(identifier.keyIdentifier.buffer) : undefined
    }
    return { certificate, notBefore, notAfter, ski, aki }
  } catch {
    throw new ResponseVerificationError('invalid-certificate')
  }
}
async function importPublicKey(certificate: ParsedCertificate): Promise<CryptoKey> {
  return cryptoProvider().subtle.importKey(
    'raw',
    certificate.certificate.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
}
async function verifySignature(key: CryptoKey, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  return cryptoProvider().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    buffer(ecdsaSignature(signature)),
    buffer(bytes)
  )
}
async function verifyChild(child: ParsedCertificate, parent: ParsedCertificate): Promise<void> {
  requireCondition(
    equal(
      AsnConvert.serialize(child.certificate.tbsCertificate.issuer),
      AsnConvert.serialize(parent.certificate.tbsCertificate.subject)
    ),
    'invalid-certificate'
  )
  requireCondition(!child.aki || !parent.ski || equal(child.aki, parent.ski), 'invalid-certificate')
  requireCondition(child.notBefore >= parent.notBefore && child.notAfter <= parent.notAfter, 'invalid-certificate')
  const tbs = child.certificate.tbsCertificateRaw
  requireCondition(tbs, 'invalid-certificate')
  requireCondition(
    await verifySignature(
      await importPublicKey(parent),
      new Uint8Array(child.certificate.signatureValue),
      new Uint8Array(tbs)
    ),
    'invalid-certificate'
  )
}

export function validateSigningRequest(request: SigningRequest): URL {
  const url = new URL(request.url)
  requireCondition(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      request.method === 'POST' &&
      request.body.length <= MAX_SIGNED_REQUEST,
    'unsupported-request'
  )
  requireCondition(
    request.headers.get(SIGNING_VERSION_HEADER) === '3' &&
      /^[0-9a-f]{32}$/.test(request.headers.get(SIGNING_NONCE_HEADER) || ''),
    'unsupported-request'
  )
  const token = request.headers.get('dd-client-token')
  requireCondition(token && !token.includes(','), 'unsupported-request')
  // Capabilities are a comma-delimited protocol list. Other semantic headers must be single-valued.
  for (const name of ['content-type', 'dd-application-id', 'x-rkyv', 'x-use-cache', 'authorization']) {
    requireCondition(!request.headers.get(name)?.includes(','), 'unsupported-request')
  }
  const capabilities =
    request.headers
      .get('x-dd-feature-flags-capabilities')
      ?.split(',')
      .map((value) => value.trim()) || []
  requireCondition(
    capabilities.includes(SIGNING_CAPABILITY) && new Set(capabilities).size === capabilities.length,
    'unsupported-request'
  )
  return url
}
function unsignedInteger(value: number, width: number): Uint8Array {
  requireCondition(Number.isSafeInteger(value) && value >= 0 && (width !== 2 || value <= 65535))
  const bytes = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) {
    bytes[i] = value % 256
    value = Math.floor(value / 256)
  }
  requireCondition(value === 0)
  return bytes
}
function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}
function lp(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? utf8(value) : value
  return concat([unsignedInteger(bytes.length, 4), bytes])
}
export async function buildSigningTranscript(
  request: SigningRequest,
  response: SigningResponse,
  issuedAt: number,
  expiresAt: number,
  leaf: Uint8Array,
  intermediate: Uint8Array
): Promise<Uint8Array> {
  const url = validateSigningRequest(request)
  const nonce = Uint8Array.from(request.headers.get(SIGNING_NONCE_HEADER)!.match(/../g)!, (pair) => parseInt(pair, 16))
  const parts = [
    utf8('datadog.feature-flags.precomputed-assignments.v3\0'),
    lp(request.method),
    lp('https'),
    lp(url.host.toLowerCase()),
    lp(url.pathname),
    lp(url.search),
    lp(nonce),
    await sha256(request.body),
    await sha256(utf8(request.headers.get('dd-client-token')!)),
  ]
  for (const name of OPTIONAL_HEADERS) {
    const value = request.headers.get(name)
    parts.push(new Uint8Array([value === null ? 0 : 1]))
    if (value !== null) parts.push(lp(value))
  }
  const auth = request.headers.get('authorization')
  parts.push(new Uint8Array([auth === null ? 0 : 1]))
  if (auth !== null) parts.push(await sha256(utf8(auth)))
  parts.push(
    unsignedInteger(response.status, 2),
    unsignedInteger(issuedAt, 8),
    unsignedInteger(expiresAt, 8),
    unsignedInteger(response.body.length, 8),
    await sha256(response.body),
    await sha256(leaf),
    await sha256(intermediate)
  )
  return concat(parts)
}

export async function verifyResponse(
  request: SigningRequest,
  response: SigningResponse,
  trustedRoots: readonly string[],
  now = Date.now() / 1000
): Promise<VerifiedResponse> {
  cryptoProvider()
  validateSigningRequest(request)
  requireCondition(trustedRoots.length > 0, 'missing-anchor')
  requireCondition(response.body.length <= MAX_SIGNED_RESPONSE, 'response-too-large')
  requireCondition(response.status === 200 && proof(response.headers, 'signature-version') === '3')
  const leafDer = decodeBase64(proof(response.headers, 'signing-certificate'), MAX_CERTIFICATE)
  const intermediateDer = decodeBase64(proof(response.headers, 'signing-intermediate'), MAX_CERTIFICATE)
  const certificateId = proof(response.headers, 'certificate-id')
  requireCondition(/^[0-9a-f]{64}$/.test(certificateId) && certificateId === hex(await sha256(leafDer)))
  const issuedAt = seconds(proof(response.headers, 'issued-at')),
    expiresAt = seconds(proof(response.headers, 'expires-at'))
  requireCondition(
    issuedAt <= now + 30 && expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= 300,
    'expired-proof'
  )
  const leaf = parseCertificate(leafDer, 'leaf'),
    intermediate = parseCertificate(intermediateDer, 'intermediate')
  await verifyChild(leaf, intermediate)
  let anchor: ParsedCertificate | undefined
  for (const root of trustedRoots) {
    try {
      const candidate = parseCertificate(decodeBase64(root, MAX_CERTIFICATE), 'anchor')
      await verifyChild(intermediate, candidate)
      if (
        now >= candidate.notBefore &&
        now < candidate.notAfter &&
        issuedAt >= candidate.notBefore &&
        expiresAt <= candidate.notAfter
      ) {
        anchor = candidate
        break
      }
    } catch {
      /* Try only explicitly configured anchors; never learn roots from the response. */
    }
  }
  requireCondition(anchor, 'invalid-certificate')
  for (const certificate of [leaf, intermediate]) {
    requireCondition(
      now >= certificate.notBefore &&
        now < certificate.notAfter &&
        issuedAt >= certificate.notBefore &&
        expiresAt <= certificate.notAfter,
      'expired-proof'
    )
  }
  const signature = decodeBase64(proof(response.headers, 'signature'), 72)
  const transcript = await buildSigningTranscript(request, response, issuedAt, expiresAt, leafDer, intermediateDer)
  requireCondition(await verifySignature(await importPublicKey(leaf), signature, transcript), 'invalid-signature')
  return { expiresAt, verifiedAt: now }
}
