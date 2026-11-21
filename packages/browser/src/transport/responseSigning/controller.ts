import { display } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { type DebugLogger, NO_DEBUG } from '../../debug'
import { buildConfigurationUrl, type ConfigurationEndpointOptions } from '../configurationEndpoint'
import { signingContextKey } from './context'
import { raiseMinimumNotBefore, storedMinimumNotBefore } from './minimumNotBefore'
import { bundledRootsForEndpoint, isSigningSite, SIGNING_SITE } from './trustRoots'
import {
  cryptoProvider,
  hex,
  MAX_SIGNED_RESPONSE,
  ResponseVerificationError,
  SIGNING_CAPABILITY,
  SIGNING_NONCE_HEADER,
  SIGNING_VERSION_HEADER,
  type SigningRequest,
  sha256,
  utf8,
  type VerifiedResponse,
  validateSigningRequest,
  verifyResponse,
} from './verification'

export { signingContextKey } from './context'

/**
 * Experimental. Response signing is in preview and works only on the Datadog staging site. The API can change or be removed in a minor release, based on customer feedback.
 * @experimental
 */
export type ResponseSigningMode = 'off' | 'observe' | 'required'

/** Required signing on a site without a bundled root and EKU fails closed with this message. */
export const UNSUPPORTED_SITE_MESSAGE =
  `Response signing: unsupported-site. This SDK version supports response signing only on the Datadog staging site ` +
  `(${SIGNING_SITE}). Production support comes in a later release. Remove experimentalResponseSigning mode 'required', or use 'observe'.`
const OBSERVE_UNSUPPORTED_SITE_MESSAGE =
  `This SDK version supports response signing only on the Datadog staging site (${SIGNING_SITE}). ` +
  `Production support comes in a later release. Flags are not verified, and requests are sent without signing.`
/**
 * Experimental. Response signing is in preview and works only on the Datadog staging site. The API can change or be removed in a minor release, based on customer feedback.
 *
 * Staging only (`site: 'datad0g.com'`); production is not supported yet.
 * @experimental
 */
export interface ResponseSigningConfiguration {
  /**
   * Default: off. Observe accepts ordinary valid responses even when verification fails.
   * Staging only (`site: 'datad0g.com'`); production is not supported yet. On other sites, `observe` is a no-op
   * with a warning, and `required` fails closed: the provider sends no assignment request and enters its error state.
   */
  mode: ResponseSigningMode
  /**
   * Explicit trusted root certificates, standard padded base64 DER. Draft dogfood/test API.
   * Overrides endpoint-selected bundled roots, including when empty. No production root is bundled yet.
   * Signing is available only when `site` is `datad0g.com`; on other sites this option is not read.
   * These public anchors are fixed for the lifetime of the provider; never populate them from a response.
   */
  trustedRootCertificates?: readonly string[]
  /**
   * Required mode only. Default: false.
   *
   * When false, at the expiry of the last verified proof the provider keeps serving the verified flags and changes
   * its state to STALE. A network attacker can block refreshes and keep the flags at their last verified values.
   * The attacker cannot forge values: the guarantee is "verified once", not "fresh".
   *
   * When true, at expiry the provider changes its state to ERROR and returns default values until a new verified
   * response arrives. This is the strict guarantee.
   */
  expireVerifiedFlags?: boolean
}

export function createResponseSigningController(
  options: ResponseSigningConfiguration | undefined,
  scope: ConfigurationEndpointOptions & Record<string, unknown> = {},
  debug: DebugLogger = NO_DEBUG
) {
  const mode = options?.mode ?? 'off'
  // Trust metadata is emitted below from the roots resolved by the operational path.
  debug.event('signing.configured', () => ({ mode }))
  if (!['off', 'observe', 'required'].includes(mode)) {
    debug.event('init.failed', () => ({ field: 'experimentalResponseSigning.mode', reason: 'invalid_signing_mode' }))
    throw new Error('Invalid response signing mode')
  }
  if (mode === 'off') return undefined
  // Staging gate: there is no production root or EKU yet. Observe is a no-op; required fails closed.
  const unsupportedSite = !isSigningSite(scope.site)
  if (unsupportedSite) {
    debug.event('signing.unavailable', () => ({
      mode,
      reason: 'unsupported_site',
      action: mode === 'required' ? 'reject_all_requests' : 'send_unsigned_request',
    }))
    if (mode === 'observe') {
      display.warn(OBSERVE_UNSUPPORTED_SITE_MESSAGE)
      return undefined
    }
    display.error(UNSUPPORTED_SITE_MESSAGE)
  }
  const endpoint = buildConfigurationUrl(scope, 'precomputed')
  // Trust options are not read off staging: every request fails before trust is needed.
  const automaticRoots = unsupportedSite || options?.trustedRootCertificates === undefined
  const roots = unsupportedSite ? [] : [...(options?.trustedRootCertificates ?? bundledRootsForEndpoint(endpoint))]
  if (roots.length > 4 || roots.some((root) => typeof root !== 'string' || root.length > 5464)) {
    debug.event('init.failed', () => ({
      field: 'experimentalResponseSigning.trustedRootCertificates',
      reason: 'invalid_trust_anchors',
    }))
    throw new Error('Invalid response signing trust anchors')
  }
  debug.event('signing.trust', () => ({
    mode,
    trustAnchorCount: roots.length,
    source: automaticRoots ? 'bundled_endpoint_roots' : 'explicit_roots',
  }))
  if (mode === 'required' && !roots.length && !unsupportedSite) {
    debug.event('init.failed', () => ({
      field: 'experimentalResponseSigning.trustedRootCertificates',
      reason: 'missing_trusted_root',
    }))
    throw new Error('Required response signing needs a locally trusted root certificate')
  }
  const expireVerifiedFlags = mode === 'required' && options?.expireVerifiedFlags === true
  const verified = new WeakMap<FlagsConfiguration, { expiresAt: number; acceptedAt: number; context: string }>()
  const serializedScope = JSON.stringify({ version: 1, mode, roots, scope })
  let namespace: Promise<string | undefined> | undefined
  function failure(error: unknown, logger = debug, stage = 'verification'): undefined {
    const reason = error instanceof ResponseVerificationError ? error.reason : 'invalid-proof'
    logger.event('signing.failed', () => ({
      mode,
      stage,
      reason,
      action: mode === 'required' ? 'reject_response' : 'continue_unverified',
    }))
    if (mode === 'required')
      throw error instanceof ResponseVerificationError ? error : new ResponseVerificationError(reason)
    return undefined
  }
  /**
   * DRAFT: keep a signed minimum not-before only when it cannot revoke any certificate of the chain that signed it.
   * Intermediates are older than the leaf, so a leaf-only check could revoke every later chain.
   */
  function recordMinimumNotBefore(proof: VerifiedResponse, logger: DebugLogger): void {
    const value = proof.minimumNotBefore
    if (value === undefined) return
    const outcome =
      value > proof.chainNotBefore
        ? 'minimum-not-before-ignored'
        : raiseMinimumNotBefore(proof.anchorKey, value)
          ? 'stored'
          : 'not-higher-than-stored'
    logger.event('signing.minimum_not_before', () => ({ mode, value, outcome }))
  }
  return {
    mode,
    expireVerifiedFlags,
    /** Hash the full immutable provider scope only when cache is used; never expose tokens in storage keys. */
    cacheNamespace(): Promise<string | undefined> {
      namespace ??= sha256(utf8(serializedScope)).then(
        (digest) => `response-signing-v1-${hex(digest)}`,
        () => {
          debug.event('cache.namespace_unavailable', () => ({
            reason: 'signing_digest_failed',
            action: 'skip_persistence',
          }))
          return undefined
        }
      )
      return namespace
    },
    prepare(url: string, headers: Record<string, string>, body: string, logger = debug): SigningRequest | undefined {
      try {
        // Thrown before the request is sent, so no assignment request leaves the client.
        if (unsupportedSite) throw new ResponseVerificationError('unsupported-site', UNSUPPORTED_SITE_MESSAGE)
        if (automaticRoots && new URL(url).origin !== endpoint.origin)
          throw new ResponseVerificationError('unsupported-request')
        const normalized = new Headers(headers)
        // Case-distinct object keys become duplicate HTTP fields, even if Headers later coalesces them.
        const semantic = new Set([
          'dd-client-token',
          'authorization',
          'content-type',
          'dd-application-id',
          'x-rkyv',
          'x-use-cache',
          'x-dd-feature-flags-capabilities',
        ])
        const seen = new Set<string>()
        for (const key of Object.keys(headers)) {
          const lower = key.toLowerCase()
          if (semantic.has(lower) && seen.has(lower)) throw new ResponseVerificationError('unsupported-request')
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
        logger.event('signing.prepared', () => ({ mode, noncePresent: true, version: 1 }))
        return request
      } catch (error) {
        return failure(error, logger, 'request_preparation')
      }
    },
    async read(
      response: Response,
      request: SigningRequest | undefined,
      logger = debug
    ): Promise<{ json: unknown; proof?: VerifiedResponse }> {
      // A custom fetch may ignore redirect: 'error'. Redirects are transport failures, even in observe mode.
      if (response.redirected) {
        logger.event('signing.failed', () => ({
          mode,
          stage: 'response',
          reason: 'redirected_response',
          action: 'reject_response',
        }))
        throw new Error('Flag configuration redirects are not supported with response signing')
      }
      if (!request) return { json: await response.json() }
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
      if (proof) recordMinimumNotBefore(proof, logger)
      logger.event('signing.verified', () => ({ mode, outcome: proof ? 'verified' : 'unverified', proof }))
      // Parse failures remain ordinary errors; never treat malformed application JSON as optional crypto failure.
      return { json: JSON.parse(new TextDecoder().decode(bytes)), proof }
    },
    admit(
      config: FlagsConfiguration,
      context: EvaluationContext,
      proof: VerifiedResponse | undefined,
      signal?: AbortSignal,
      logger = debug
    ): void {
      signal?.throwIfAborted()
      if (proof) {
        if (proof.expiresAt <= Date.now() / 1000 || proof.verifiedAt > Date.now() / 1000) {
          failure(new ResponseVerificationError('expired-proof'), logger, 'admission')
          return
        }
        logger.event('signing.admitted', () => ({ mode, expiresAt: proof.expiresAt, verifiedAt: proof.verifiedAt }))
        verified.set(config, { ...proof, acceptedAt: proof.verifiedAt, context: signingContextKey(context) })
      }
    },
    isExpired(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      const proof = config && verified.get(config)
      return !!proof && proof.expiresAt <= Date.now() / 1000 && proof.context === signingContextKey(context)
    },
    /** Verified now, or (unless expireVerifiedFlags) verified once with an expired proof: the flags stay usable. */
    isUsable(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      if (!config) return false
      const proof = verified.get(config)
      return (
        !!proof &&
        proof.acceptedAt <= Date.now() / 1000 &&
        (!expireVerifiedFlags || proof.expiresAt > Date.now() / 1000) &&
        proof.context === signingContextKey(context)
      )
    },
    isVerified(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      if (!config) return false
      const proof = verified.get(config)
      return (
        !!proof &&
        proof.acceptedAt <= Date.now() / 1000 &&
        proof.expiresAt > Date.now() / 1000 &&
        proof.context === signingContextKey(context)
      )
    },
  }
}
export type ResponseSigningController = NonNullable<ReturnType<typeof createResponseSigningController>>
