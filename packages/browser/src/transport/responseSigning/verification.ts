import { AsnConvert } from '@peculiar/asn1-schema'
import {
  AuthorityKeyIdentifier,
  BasicConstraints,
  Certificate,
  ExtendedKeyUsage,
  KeyUsage,
  SubjectKeyIdentifier,
} from '@peculiar/asn1-x509'
import {
  BOUND_REQUEST_HEADERS,
  buffer,
  CLOCK_TOLERANCE_SECONDS,
  type ClockFloors,
  cryptoProvider,
  hex,
  MAX_SIGNED_REQUEST,
  MAX_SIGNED_RESPONSE,
  MINIMUM_LEAF_NOT_BEFORE_HEADER,
  monotonicNow,
  NO_CLOCK_FLOORS,
  ResponseVerificationError,
  requireCondition,
  SIGNED_HEADERS_HEADER,
  SIGNED_RESPONSE_HEADERS_HEADER,
  SIGNING_CAPABILITY,
  SIGNING_CHAIN_HEADER,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION,
  SIGNING_VERSION_HEADER,
  type SigningRequest,
  type SigningResponse,
  sha256,
  utf8,
  type VerificationFailure,
  type VerifiedResponse,
} from './protocol'

// The certificate verifier. The provider loads this module as a dynamic chunk, so it is not in the default bundle.
export * from './protocol'

const TRANSCRIPT_DOMAIN = 'datadog.feature-flags.precomputed-assignments.v1\0'
const PREFIX = 'x-datadog-feature-flags-'
const MAX_CERTIFICATE = 4096
const MAX_INTERMEDIATES = 3
/**
 * FFE assignment-signing extended key usage (DER 06 0a 2b 06 01 04 01 86 8d 1f 01 01).
 * PLACEHOLDER: 1.3.6.1.4.1.99999 is not a Datadog-owned arc. Datadog must assign the
 * production OID before merge. Keep this the only definition of the OID in the SDK.
 */
const FFE_ASSIGNMENT_SIGNING_EKU = '1.3.6.1.4.1.99999.1.1'
const ANY_EXTENDED_KEY_USAGE = '2.5.29.37.0'
const ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const P256_PARAMETERS = new Uint8Array([6, 8, 42, 134, 72, 206, 61, 3, 1, 7])
const CAPABILITIES_HEADER = 'x-dd-feature-flags-capabilities'
/** Lowercase HTTP token characters, at most 64 bytes. */
const LIST_NAME = /^[0-9a-z!#$%&'*+.^_`|~-]{1,64}$/
const MAX_LISTED_NAMES = 32
/** The 8 proof headers, which a response list must not name. */
const PROOF_HEADERS = [
  'signature-version',
  'signing-certificate',
  'signing-chain',
  'certificate-id',
  'issued-at',
  'expires-at',
  'signature',
  'signed-response-headers',
].map((name) => PREFIX + name)
/** Response headers with one value. A repeated field arrives joined by ', ', so a comma means more than one line. */
const SINGLE_VALUE_RESPONSE_HEADERS = ['content-type', 'dd-flag-selection-ignored']

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
/** Intermediates: standard base64 DER joined by ',' without spaces, index 0 issued the leaf. */
function chain(headers: Headers): Uint8Array[] {
  const value = headers.get(SIGNING_CHAIN_HEADER)
  requireCondition(value !== null && value.length > 0, 'missing-proof')
  requireCondition(value.length <= MAX_INTERMEDIATES * (4 * Math.ceil(MAX_CERTIFICATE / 3) + 1) - 1)
  const entries = value.split(',')
  requireCondition(entries.length >= 1 && entries.length <= MAX_INTERMEDIATES)
  return entries.map((entry) => decodeBase64(entry, MAX_CERTIFICATE))
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

/**
 * X.690 11.2.2: a DER named-bit list omits every trailing zero bit. The schema serializer keeps the input
 * bytes, so check minimality directly: the lowest bit kept is set, or the list is empty.
 */
function minimalNamedBits(der: Uint8Array): boolean {
  if (der.length < 3 || der[0] !== 3 || der[1] !== der.length - 2) return false
  const unused = der[2]
  if (der.length === 3) return unused === 0
  const last = der[der.length - 1]
  return unused <= 7 && ((last >> unused) & 1) === 1
}

export interface ParsedCertificate {
  certificate: Certificate
  notBefore: number
  notAfter: number
  ski?: Uint8Array
  aki?: Uint8Array
  /** Decoded basicConstraints pathLenConstraint, when present. */
  pathLength?: number
}
/**
 * `index` is the intermediate position: 0 issued the leaf. It is ignored for other roles.
 * Exported for tests only; it is not part of the package entry points.
 */
export function parseCertificate(
  der: Uint8Array,
  role: 'leaf' | 'intermediate' | 'anchor',
  index = 0
): ParsedCertificate {
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
      requireCondition(
        !['2.5.29.30', '2.5.29.33', '2.5.29.36', '2.5.29.54'].includes(extension.extnID),
        'invalid-certificate'
      )
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
    let pathLength: number | undefined
    if (role === 'anchor') {
      // The anchor pathLenConstraint is read for the chain-length check. Present values must be canonical DER.
      if (basic) pathLength = parseDer(new Uint8Array(basic.extnValue.buffer), BasicConstraints).pathLenConstraint
      if (usage) {
        const keyUsageDer = new Uint8Array(usage.extnValue.buffer)
        parseDer(keyUsageDer, KeyUsage)
        requireCondition(minimalNamedBits(keyUsageDer), 'invalid-certificate')
      }
    }
    if (role !== 'anchor') {
      requireCondition(basic?.critical && usage?.critical, 'invalid-certificate')
      const basicDer = new Uint8Array(basic.extnValue.buffer)
      // A leaf basicConstraints is exactly the empty SEQUENCE (30 00): cA FALSE is the omitted default.
      requireCondition(role !== 'leaf' || equal(basicDer, new Uint8Array([48, 0])), 'invalid-certificate')
      const constraints = parseDer(basicDer, BasicConstraints)
      pathLength = constraints.pathLenConstraint
      // Decode pathLenConstraint; never compare fixed bytes. Intermediate i has i CAs below it, so pathLen >= i.
      requireCondition(
        role === 'leaf'
          ? !constraints.cA && pathLength === undefined
          : constraints.cA && pathLength !== undefined && Number.isSafeInteger(pathLength) && pathLength >= index,
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
      requireCondition(purposes.length > 0, 'invalid-certificate')
      if (role === 'leaf') {
        // The product OID is required; other OIDs are allowed; anyExtendedKeyUsage is forbidden.
        requireCondition(
          purposes.includes(FFE_ASSIGNMENT_SIGNING_EKU) && !purposes.includes(ANY_EXTENDED_KEY_USAGE),
          'invalid-certificate'
        )
      } else {
        // Intermediates and the pinned root: an EKU, if present, must allow FFE assignment signing.
        requireCondition(
          purposes.includes(FFE_ASSIGNMENT_SIGNING_EKU) || purposes.includes(ANY_EXTENDED_KEY_USAGE),
          'invalid-certificate'
        )
      }
    }
    const skiExtension = extensions.get('2.5.29.14'),
      akiExtension = extensions.get('2.5.29.35')
    const ski = skiExtension
      ? new Uint8Array(parseDer(new Uint8Array(skiExtension.extnValue.buffer), SubjectKeyIdentifier).buffer)
      : undefined
    requireCondition(!skiExtension || (ski !== undefined && ski.length > 0), 'invalid-certificate')
    let aki: Uint8Array | undefined
    if (akiExtension) {
      const identifier = parseDer(new Uint8Array(akiExtension.extnValue.buffer), AuthorityKeyIdentifier)
      requireCondition(
        identifier.authorityCertIssuer === undefined && identifier.authorityCertSerialNumber === undefined,
        'invalid-certificate'
      )
      aki = identifier.keyIdentifier ? new Uint8Array(identifier.keyIdentifier.buffer) : undefined
      requireCondition(aki !== undefined && aki.length > 0, 'invalid-certificate')
    }
    return { certificate, notBefore, notAfter, ski, aki, pathLength }
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
/** Exported for tests only; it is not part of the package entry points. */
export async function verifyChild(child: ParsedCertificate, parent: ParsedCertificate): Promise<void> {
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
    request.headers.get(SIGNING_VERSION_HEADER) === SIGNING_VERSION &&
      /^[0-9a-f]{32}$/.test(request.headers.get(SIGNING_NONCE_HEADER) || ''),
    'unsupported-request'
  )
  const token = request.headers.get('dd-client-token')
  requireCondition(token && !request.headers.get('authorization')?.includes(','), 'unsupported-request')
  const listed = signedRequestHeaders(request.headers)
  requireCondition(
    listed.includes('content-type') &&
      listed.includes(CAPABILITIES_HEADER) &&
      !listed.some((name) => name === 'dd-client-token' || name === 'authorization' || name.startsWith(PREFIX)) &&
      BOUND_REQUEST_HEADERS.every((name) => listed.includes(name) || request.headers.get(name) === null),
    'unsupported-request'
  )
  for (const name of [...listed, 'dd-client-token']) {
    const value = request.headers.get(name)
    // Each listed header is present. Capabilities are a comma-delimited list; other values have one line.
    requireCondition(value !== null && (name === CAPABILITIES_HEADER || !value.includes(',')), 'unsupported-request')
  }
  const capabilities =
    request.headers
      .get(CAPABILITIES_HEADER)
      ?.split(',')
      .map((value) => value.trim()) || []
  requireCondition(
    capabilities.includes(SIGNING_CAPABILITY) && new Set(capabilities).size === capabilities.length,
    'unsupported-request'
  )
  return url
}
/** A signed header list: 1 to 32 lowercase token names, unique, in ascending byte order, joined by ',' with no spaces. */
function headerList(value: string, reason: VerificationFailure): string[] {
  const names = value.split(',')
  requireCondition(
    names.length <= MAX_LISTED_NAMES &&
      names.every((name, index) => LIST_NAME.test(name) && (index === 0 || names[index - 1] < name)),
    reason
  )
  return names
}
function signedRequestHeaders(headers: Headers): string[] {
  const value = headers.get(SIGNED_HEADERS_HEADER)
  requireCondition(value !== null, 'unsupported-request')
  return headerList(value, 'unsupported-request')
}
/** A request has a flag selection when its JSON body has a non-null flag_selection, or its query selects flags. */
function hasFlagSelection(request: SigningRequest, url: URL): boolean {
  // As the shared fixtures: a selection query parameter counts only with a non-empty value.
  if (['selected_flag_tags', 'selected_flag_key_patterns'].some((name) => url.searchParams.getAll(name).some(Boolean)))
    return true
  let body: { flag_selection?: unknown; data?: { attributes?: { flag_selection?: unknown } } } | null
  try {
    body = JSON.parse(new TextDecoder().decode(request.body))
  } catch {
    return false
  }
  // The shared fixtures put the field at the top level of a JSON object. The SDK sends JSON:API, so
  // data.attributes.flag_selection also counts: the SDK then requires the verified dd-flag-selection-ignored entry.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  return (body.flag_selection ?? null) !== null || (body.data?.attributes?.flag_selection ?? null) !== null
}
function signedResponseHeaders(request: SigningRequest, url: URL, headers: Headers): string[] {
  const value = headers.get(SIGNED_RESPONSE_HEADERS_HEADER)
  requireCondition(value, 'missing-proof')
  const names = headerList(value, 'invalid-proof')
  requireCondition(
    names.includes('content-type') &&
      (names.includes('dd-flag-selection-ignored') || !hasFlagSelection(request, url)) &&
      !names.some((name) => PROOF_HEADERS.includes(name)) &&
      SINGLE_VALUE_RESPONSE_HEADERS.every((name) => !names.includes(name) || !headers.get(name)?.includes(','))
  )
  return names
}
/** `u8(count)`, then for each name in list order: `lp(name) u8(1) lp(value)`, or `lp(name) u8(0) lp("")` when absent. */
function listTranscript(names: readonly string[], headers: Headers): Uint8Array[] {
  const parts: Uint8Array[] = [new Uint8Array([names.length])]
  for (const name of names) {
    const value = headers.get(name)
    parts.push(lp(name), new Uint8Array([value === null ? 0 : 1]), lp(value ?? ''))
  }
  return parts
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
  intermediates: readonly Uint8Array[],
  minimumNotBefore?: number
): Promise<Uint8Array> {
  const url = validateSigningRequest(request)
  requireCondition(intermediates.length >= 1 && intermediates.length <= MAX_INTERMEDIATES)
  const nonce = Uint8Array.from(request.headers.get(SIGNING_NONCE_HEADER)!.match(/../g)!, (pair) => parseInt(pair, 16))
  const parts = [
    utf8(TRANSCRIPT_DOMAIN),
    lp(request.method),
    lp('https'),
    // WHATWG URL host: lowercase, IPv6 in brackets, and no port when it is the scheme default (443).
    lp(url.host.toLowerCase()),
    lp(url.pathname),
    // WHATWG search is '' for both "/p" and "/p?". The edge, iOS and Android encode an empty query as "?".
    lp(url.search || (url.href.replace(/#.*$/, '').endsWith('?') ? '?' : '')),
    lp(nonce),
    await sha256(request.body),
    await sha256(utf8(request.headers.get('dd-client-token')!)),
  ]
  parts.push(...listTranscript(signedRequestHeaders(request.headers), request.headers))
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
    // Chain tail: u8 intermediate count, then the digest of each intermediate in header order.
    new Uint8Array([intermediates.length])
  )
  for (const intermediate of intermediates) parts.push(await sha256(intermediate))
  parts.push(...listTranscript(signedResponseHeaders(request, url, response.headers), response.headers))
  // DRAFT: an optional signed tail. Without the header, the v1 transcript is unchanged.
  if (minimumNotBefore !== undefined) parts.push(new Uint8Array([1]), unsignedInteger(minimumNotBefore, 8))
  return concat(parts)
}

export async function verifyResponse(
  request: SigningRequest,
  response: SigningResponse,
  trustedRoots: readonly string[],
  now = Date.now() / 1000,
  /** Stored minimum not-before for a trust anchor (SHA-256 hex of its DER); 0 when none. */
  storedMinimumNotBefore: (anchorKey: string) => number = () => 0,
  /** The clock floors. The checks use max(now, build floor, high-water mark of the anchor). Default: none. */
  floors: ClockFloors = NO_CLOCK_FLOORS
): Promise<VerifiedResponse> {
  cryptoProvider()
  const url = validateSigningRequest(request)
  requireCondition(trustedRoots.length > 0, 'missing-anchor')
  requireCondition(response.body.length <= MAX_SIGNED_RESPONSE, 'response-too-large')
  requireCondition(response.status === 200 && proof(response.headers, 'signature-version') === SIGNING_VERSION)
  const leafDer = decodeBase64(proof(response.headers, 'signing-certificate'), MAX_CERTIFICATE)
  const intermediateDers = chain(response.headers)
  const certificateId = proof(response.headers, 'certificate-id')
  requireCondition(/^[0-9a-f]{64}$/.test(certificateId) && certificateId === hex(await sha256(leafDer)))
  const issuedAt = seconds(proof(response.headers, 'issued-at')),
    expiresAt = seconds(proof(response.headers, 'expires-at'))
  const responseHeaderNames = signedResponseHeaders(request, url, response.headers)
  // One decimal field line only: duplicated lines arrive joined by ', ' and fail the decimal check.
  const minimumNotBeforeValue = response.headers.get(MINIMUM_LEAF_NOT_BEFORE_HEADER)
  const minimumNotBefore = minimumNotBeforeValue === null ? undefined : seconds(minimumNotBeforeValue)
  // The anchor and its high-water mark are not known yet. A mark only moves the time forward, so a proof that is
  // expired at the build floor stays expired. The issued-at bound waits for the mark.
  const floorNow = Math.max(now, floors.build)
  requireCondition(expiresAt > floorNow && expiresAt > issuedAt && expiresAt - issuedAt <= 300, 'expired-proof')
  const leaf = parseCertificate(leafDer, 'leaf')
  const intermediates = intermediateDers.map((der, index) => parseCertificate(der, 'intermediate', index))
  // Path: leaf -> intermediate[0] -> ... -> intermediate[n-1] -> pinned root. Every link is checked.
  await verifyChild(leaf, intermediates[0])
  for (let index = 0; index + 1 < intermediates.length; index++) {
    await verifyChild(intermediates[index], intermediates[index + 1])
  }
  const last = intermediates[intermediates.length - 1]
  let anchor: ParsedCertificate | undefined
  let anchorKey = ''
  let effectiveNow = floorNow
  for (const root of trustedRoots) {
    try {
      const candidateDer = decodeBase64(root, MAX_CERTIFICATE)
      const candidate = parseCertificate(candidateDer, 'anchor')
      requireCondition(
        candidate.pathLength === undefined || candidate.pathLength >= intermediates.length,
        'invalid-certificate'
      )
      await verifyChild(last, candidate)
      const candidateKey = hex(await sha256(candidateDer))
      const candidateNow = Math.max(floorNow, floors.highWaterMark(candidateKey))
      if (
        candidateNow >= candidate.notBefore &&
        candidateNow < candidate.notAfter &&
        issuedAt >= candidate.notBefore &&
        expiresAt <= candidate.notAfter
      ) {
        anchor = candidate
        anchorKey = candidateKey
        effectiveNow = candidateNow
        break
      }
    } catch {
      /* Try only explicitly configured anchors; never learn roots from the response. */
    }
  }
  requireCondition(anchor, 'invalid-certificate')
  // A clock set back below the last verified issued-at cannot make an older proof current again.
  requireCondition(issuedAt <= effectiveNow + CLOCK_TOLERANCE_SECONDS && expiresAt > effectiveNow, 'expired-proof')
  const floor = storedMinimumNotBefore(anchorKey)
  // Leaf only: intermediates live for years, so comparing them would block every later leaf.
  requireCondition(leaf.notBefore >= floor, 'revoked-certificate')
  for (const certificate of [leaf, ...intermediates]) {
    requireCondition(
      effectiveNow >= certificate.notBefore &&
        effectiveNow < certificate.notAfter &&
        issuedAt >= certificate.notBefore &&
        expiresAt <= certificate.notAfter,
      'expired-proof'
    )
  }
  const signature = decodeBase64(proof(response.headers, 'signature'), 72)
  const transcript = await buildSigningTranscript(
    request,
    response,
    issuedAt,
    expiresAt,
    leafDer,
    intermediateDers,
    minimumNotBefore
  )
  requireCondition(await verifySignature(await importPublicKey(leaf), signature, transcript), 'invalid-signature')
  // Act only on these values: an unlisted response header is not verified.
  const verifiedResponseHeaders: Record<string, string | null> = {}
  for (const name of responseHeaderNames) verifiedResponseHeaders[name] = response.headers.get(name)
  return {
    issuedAt,
    expiresAt,
    verifiedAt: now,
    effectiveVerifiedAt: effectiveNow,
    verifiedMonotonicMs: monotonicNow(),
    anchorKey,
    leafNotBefore: leaf.notBefore,
    minimumNotBefore,
    verifiedResponseHeaders,
  }
}
