import { display } from '@datadog/browser-core'
import { type FlagsConfiguration, parsePrecomputedConfigurationJson } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { type DebugLogger, NO_DEBUG } from '../../debug'
import { buildConfigurationUrl, type ConfigurationEndpointOptions } from '../configurationEndpoint'
import { signingContextKey } from './context'
import {
  CLOCK_TOLERANCE_SECONDS,
  hex,
  ResponseVerificationError,
  type SigningRequest,
  sha256,
  signingFailureMessage,
  utf8,
  type VerificationFailure,
  type VerifiedResponse,
} from './protocol'
import { bundledRootsForEndpoint, isSigningSite, SIGNING_SITE } from './trustRoots'

type Exchange = typeof import('./exchange')

/** Required mode fails closed with this message when the verifier chunk does not load. */
export const VERIFIER_UNAVAILABLE_MESSAGE = signingFailureMessage('verifier-unavailable')
/** The longest time that a request waits for the verifier chunk. A later load still serves the next request. */
export const VERIFIER_LOAD_TIMEOUT_MS = 5000

export { signingContextKey } from './context'

/**
 * Experimental. Response signing is in preview and works only on the Datadog staging site. The API can change or be removed in a minor release, based on customer feedback.
 * @experimental
 */
export type ResponseSigningMode = 'off' | 'observe' | 'required'

/** Required signing on a site without a bundled root and EKU fails closed with this message. */
export const UNSUPPORTED_SITE_MESSAGE = `${signingFailureMessage('unsupported-site')} The staging site is ${SIGNING_SITE}. Remove experimentalResponseSigning mode 'required', or use 'observe'.`
const OBSERVE_UNSUPPORTED_SITE_MESSAGE = `${signingFailureMessage('unsupported-site')} The staging site is ${SIGNING_SITE}. Flags are not verified, and requests are sent without signing.`
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
      reason: 'unsupported-site',
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
      reason: 'missing-anchor',
    }))
    throw new ResponseVerificationError('missing-anchor')
  }
  if (mode === 'observe' && !roots.length && !unsupportedSite) {
    // No root can verify a response: send ordinary requests, without signing headers or the verifier chunk.
    debug.event('signing.unavailable', () => ({ mode, reason: 'missing-anchor', action: 'send_unsigned_request' }))
    display.warn(`${signingFailureMessage('missing-anchor')} Flags are not verified.`)
    return undefined
  }
  // The verifier loads as a dynamic chunk while signing is experimental. Revisit at GA: an opt-in entry point may be a
  // better fit. Load it now, in parallel with the first request. A failed load is tried again on the next response.
  let exchange: Promise<Exchange> | undefined
  function loadExchange(): Promise<Exchange> {
    exchange ??= import('./exchange').catch((error: unknown) => {
      exchange = undefined
      throw error
    })
    return exchange
  }
  if (!unsupportedSite) loadExchange().catch(() => undefined)
  /** A stalled chunk must not hold the assignment request. */
  function loadExchangeWithin(ms: number): Promise<Exchange> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('verifier load timed out')), ms)
    })
    return Promise.race([loadExchange(), timeout]).finally(() => clearTimeout(timer))
  }
  // Observe mode warns once for each reason code, so that failures are visible without debug mode.
  const reported = new Set<VerificationFailure>()
  function reportObserved(reason: VerificationFailure): undefined {
    if (!reported.has(reason)) {
      reported.add(reason)
      display.warn(`${signingFailureMessage(reason)} Flags are not verified.`)
    }
    return undefined
  }
  const expireVerifiedFlags = mode === 'required' && options?.expireVerifiedFlags === true
  const verified = new WeakMap<FlagsConfiguration, { expiresAt: number; verifiedAt: number; context: string }>()
  /**
   * A proof is current from its verification time until expires-at. A backward clock step of at most
   * CLOCK_TOLERANCE_SECONDS keeps it current. A larger step is handled as expiry, and the proof is current again when
   * the clock returns into the window.
   */
  function outsideValidity(proof: { expiresAt: number; verifiedAt: number }): boolean {
    const now = Date.now() / 1000
    return proof.expiresAt <= now || proof.verifiedAt > now + CLOCK_TOLERANCE_SECONDS
  }
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
    return reportObserved(reason)
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
    async prepare(
      url: string,
      headers: Record<string, string>,
      body: string,
      logger = debug
    ): Promise<SigningRequest | undefined> {
      try {
        // Thrown before the request is sent, so no assignment request leaves the client.
        if (unsupportedSite) throw new ResponseVerificationError('unsupported-site', UNSUPPORTED_SITE_MESSAGE)
        if (automaticRoots && new URL(url).origin !== endpoint.origin)
          throw new ResponseVerificationError('unsupported-request')
      } catch (error) {
        return failure(error, logger, 'request_preparation')
      }
      let loaded: Exchange
      try {
        loaded = await loadExchangeWithin(VERIFIER_LOAD_TIMEOUT_MS)
      } catch {
        logger.event('signing.failed', () => ({
          mode,
          stage: 'verifier_load',
          reason: 'verifier-unavailable',
          action: mode === 'required' ? 'reject_request' : 'send_unsigned_request',
        }))
        // Observe sends the request without signing; required sends no assignment request.
        if (mode === 'required') throw new ResponseVerificationError('verifier-unavailable')
        return reportObserved('verifier-unavailable')
      }
      try {
        const request = loaded.signedRequest(url, headers, body)
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
      if (!request) return { json: parsePrecomputedConfigurationJson(await response.text()) }
      // A request is signed only after the chunk loaded, so this does not fail.
      return (await loadExchange()).readSignedResponse(response, request, { mode, roots, failure }, logger)
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
        if (outsideValidity(proof)) {
          failure(new ResponseVerificationError('expired-proof'), logger, 'admission')
          return
        }
        logger.event('signing.admitted', () => ({ mode, expiresAt: proof.expiresAt, verifiedAt: proof.verifiedAt }))
        verified.set(config, { ...proof, context: signingContextKey(context) })
      }
    },
    /** Unix seconds at which the verified proof of this configuration expires, when it has one. */
    expiresAt(config: FlagsConfiguration | undefined): number | undefined {
      return config ? verified.get(config)?.expiresAt : undefined
    },
    /** The proof expired, or the clock moved back more than the tolerance, for the requested context. */
    isExpired(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      const proof = config && verified.get(config)
      return !!proof && outsideValidity(proof) && proof.context === signingContextKey(context)
    },
    /** Verified now, or (unless expireVerifiedFlags) verified once with an expired proof: the flags stay usable. */
    isUsable(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      if (!config) return false
      const proof = verified.get(config)
      return (
        !!proof && (!expireVerifiedFlags || !outsideValidity(proof)) && proof.context === signingContextKey(context)
      )
    },
    isVerified(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      if (!config) return false
      const proof = verified.get(config)
      return !!proof && !outsideValidity(proof) && proof.context === signingContextKey(context)
    },
  }
}
export type ResponseSigningController = NonNullable<ReturnType<typeof createResponseSigningController>>
