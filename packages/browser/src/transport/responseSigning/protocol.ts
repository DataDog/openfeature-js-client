import { GeneralError } from '@openfeature/web-sdk'

/**
 * Response signing protocol parts that the default provider path needs: header names, limits, reason codes,
 * the error class, digest helpers and request validation. This module must not import the certificate verifier
 * or its ASN.1 libraries: `verification.ts` loads as a dynamic chunk only when signing is on.
 */
export const SIGNING_VERSION_HEADER = 'x-datadog-feature-flags-signature-version'
export const SIGNING_NONCE_HEADER = 'x-datadog-feature-flags-request-nonce'
export const SIGNING_CAPABILITY = 'response-signing-v1'
/** Request and response signature version. */
export const SIGNING_VERSION = '1'
/** Intermediate certificates: 1 to 3 standard base64 DER entries joined by ',', index 0 issued the leaf. */
export const SIGNING_CHAIN_HEADER = 'x-datadog-feature-flags-signing-chain'
/**
 * DRAFT wire, pending the edge and the shared fixtures. Unix seconds: a LEAF that starts before this time is revoked
 * for the response's trust anchor. Intermediates are never compared with it. When present, it is bound at the end of
 * the v1 transcript. The edge must list it in Access-Control-Expose-Headers, or the browser cannot read it.
 */
export const MINIMUM_LEAF_NOT_BEFORE_HEADER = 'x-datadog-feature-flags-minimum-leaf-not-before'
/**
 * Clock tolerance in seconds. A proof can be issued at most this far in the future. Verified flags stay current
 * after a backward clock step of at most this size. A larger step is handled as proof expiry.
 */
export const CLOCK_TOLERANCE_SECONDS = 30
export const MAX_SIGNED_REQUEST = 1024 * 1024
export const MAX_SIGNED_RESPONSE = 2 * 1024 * 1024

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
  | 'unsupported-site'
  | 'verifier-unavailable'
  | 'revoked-certificate'

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
  /** SHA-256 hex of the DER of the trust anchor that the chain ended at. */
  anchorKey: string
  /** notBefore of the leaf that signed the response, unix seconds. */
  leafNotBefore: number
  /** DRAFT: the signed minimum leaf not-before value, when the response has one. */
  minimumNotBefore?: number
}

/**
 * The shared reason-code table of iOS, Android and the browser: what failed, then a fix hint.
 * `revoked-certificate` is a draft rule and keeps its earlier text.
 */
const FAILURES: Record<Exclude<VerificationFailure, 'revoked-certificate'>, [string, string]> = {
  'unsupported-request': [
    'The SDK cannot sign this request shape',
    'Use the default flags endpoint and request options',
  ],
  'unavailable-crypto': ['The platform crypto API is not available', 'Use a secure (HTTPS) context'],
  'missing-anchor': [
    'No trusted root is configured for this site',
    'Response signing supports only the staging site in this release',
  ],
  'missing-proof': [
    'The response has no signature headers',
    'A proxy, CDN or custom endpoint removed the signature headers, or the organization is not enrolled',
  ],
  'invalid-proof': ['The signature headers are present but not valid', 'A proxy or CDN changed the response headers'],
  'response-too-large': ['The body is larger than the signed size limit', 'Contact Datadog support'],
  'invalid-certificate': [
    'The certificate chain does not chain to the pinned root, or a chain rule fails',
    'The response did not come from Datadog, or the network intercepts TLS. Contact Datadog support',
  ],
  'invalid-signature': ['The signature does not match the request and response', 'The response changed in transit'],
  'expired-proof': ['The proof is expired or not yet valid', 'Check the device clock'],
  'unsupported-site': [
    'Signing is not available on this Datadog site',
    'Response signing supports only the staging site in this release. Production is not supported yet',
  ],
  // Browser only: the verifier loads as a separate chunk.
  'verifier-unavailable': [
    'The response signing verifier did not load',
    'Check that the page can load the SDK chunk files',
  ],
}
/** `Flag response signing failed (<code>): <what failed>. <fix hint>.` */
export function signingFailureMessage(reason: VerificationFailure): string {
  if (reason === 'revoked-certificate') return `Response signing: ${reason}`
  const [what, hint] = FAILURES[reason]
  return `Flag response signing failed (${reason}): ${what}. ${hint}.`
}

// Errors contain only fixed diagnostic codes, never request or certificate contents.
export class ResponseVerificationError extends GeneralError {
  constructor(
    readonly reason: VerificationFailure,
    message = signingFailureMessage(reason)
  ) {
    super(message)
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = 'ResponseVerificationError'
  }
}
export function requireCondition(condition: unknown, reason: VerificationFailure = 'invalid-proof'): asserts condition {
  if (!condition) throw new ResponseVerificationError(reason)
}
export function cryptoProvider(): Crypto {
  requireCondition(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues, 'unavailable-crypto')
  return globalThis.crypto
}
export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
export function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await cryptoProvider().subtle.digest('SHA-256', buffer(bytes)))
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}
