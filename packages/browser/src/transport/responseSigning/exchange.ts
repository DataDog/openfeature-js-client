import type { DebugLogger } from '../../debug'
import { raiseMinimumNotBefore, storedMinimumNotBefore } from './minimumNotBefore'
import {
  cryptoProvider,
  hex,
  MAX_SIGNED_RESPONSE,
  ResponseVerificationError,
  SIGNING_CAPABILITY,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION_HEADER,
  type SigningRequest,
  utf8,
  type VerifiedResponse,
} from './protocol'
import { validateSigningRequest, verifyResponse } from './verification'

/**
 * The signed request and response path. The controller loads this module and the certificate verifier as a dynamic
 * chunk only when signing is on, so the default bundle does not contain them.
 */
export interface ExchangeOptions {
  mode: 'observe' | 'required'
  roots: readonly string[]
  /** Logs the failure. Throws in required mode and returns in observe mode. */
  failure(error: unknown, logger: DebugLogger, stage?: string): undefined
}

const SEMANTIC_HEADERS = new Set([
  'dd-client-token',
  'authorization',
  'content-type',
  'dd-application-id',
  'x-rkyv',
  'x-use-cache',
  'x-dd-feature-flags-capabilities',
])

export function signedRequest(url: string, headers: Record<string, string>, body: string): SigningRequest {
  const normalized = new Headers(headers)
  // Case-distinct object keys become duplicate HTTP fields, even if Headers later coalesces them.
  const seen = new Set<string>()
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (SEMANTIC_HEADERS.has(lower) && seen.has(lower)) throw new ResponseVerificationError('unsupported-request')
    seen.add(lower)
  }
  // No transport override: the edge buffers a response that it signs, so the SDK never sends X-stream.
  normalized.set(SIGNING_VERSION_HEADER, '1')
  normalized.set(SIGNING_NONCE_HEADER, hex(cryptoProvider().getRandomValues(new Uint8Array(16))))
  const capabilities =
    normalized
      .get('x-dd-feature-flags-capabilities')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) || []
  if (!capabilities.includes(SIGNING_CAPABILITY)) capabilities.push(SIGNING_CAPABILITY)
  normalized.set('x-dd-feature-flags-capabilities', capabilities.sort().join(','))
  const request = { url, method: 'POST', headers: normalized, body: utf8(body) }
  validateSigningRequest(request)
  return request
}

/**
 * DRAFT: keep a signed minimum leaf not-before only when it cannot revoke the leaf that signed it.
 * It is never compared with intermediates.
 */
function recordMinimumNotBefore(proof: VerifiedResponse, mode: string, logger: DebugLogger): void {
  const value = proof.minimumNotBefore
  if (value === undefined) return
  const outcome =
    value > proof.leafNotBefore
      ? 'minimum-not-before-ignored'
      : raiseMinimumNotBefore(proof.anchorKey, value)
        ? 'stored'
        : 'not-higher-than-stored'
  logger.event('signing.minimum_not_before', () => ({ mode, value, outcome }))
}

export async function readSignedResponse(
  response: Response,
  request: SigningRequest,
  { mode, roots, failure }: ExchangeOptions,
  logger: DebugLogger
): Promise<{ json: unknown; proof?: VerifiedResponse }> {
  // Response bodies are application bytes: fetch has already decompressed HTTP content-encoding.
  let bytes: Uint8Array
  if (mode === 'required' && response.body) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        length += result.value.length
        if (length > MAX_SIGNED_RESPONSE) {
          void reader.cancel().catch(() => undefined)
          failure(new ResponseVerificationError('response-too-large'), logger)
        }
        chunks.push(result.value)
      }
    } finally {
      reader.releaseLock()
    }
    bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
  } else bytes = new Uint8Array(await response.arrayBuffer())
  let proof: VerifiedResponse | undefined
  try {
    proof = await verifyResponse(
      request,
      { status: response.status, headers: response.headers, body: bytes },
      roots,
      undefined,
      storedMinimumNotBefore
    )
  } catch (error) {
    failure(error, logger)
  }
  // Observe mode also records values, but only from a response that verified fully.
  if (proof) recordMinimumNotBefore(proof, mode, logger)
  logger.event('signing.verified', () => ({ mode, outcome: proof ? 'verified' : 'unverified', proof }))
  // Parse failures remain ordinary errors; never treat malformed application JSON as optional crypto failure.
  return { json: JSON.parse(new TextDecoder().decode(bytes)), proof }
}
