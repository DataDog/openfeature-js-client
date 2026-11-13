import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { buildConfigurationUrl, type ConfigurationEndpointOptions } from '../configurationEndpoint'
import { signingContextKey } from './context'
import { bundledRootsForEndpoint } from './trustRoots'
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

export type ResponseSigningMode = 'off' | 'observe' | 'required'
export interface ResponseSigningConfiguration {
  /** Default: off. Observe accepts ordinary valid responses even when verification fails. */
  mode: ResponseSigningMode
  /**
   * Explicit trusted root certificates, standard padded base64 DER. Draft dogfood/test API.
   * Overrides endpoint-selected bundled roots, including when empty. No production root is bundled yet.
   * These public anchors are fixed for the lifetime of the provider; never populate them from a response.
   */
  trustedRootCertificates?: readonly string[]
}

export function createResponseSigningController(
  options: ResponseSigningConfiguration | undefined,
  scope: ConfigurationEndpointOptions & Record<string, unknown> = {}
) {
  const mode = options?.mode ?? 'off'
  if (!['off', 'observe', 'required'].includes(mode)) throw new Error('Invalid response signing mode')
  if (mode === 'off') return undefined
  const endpoint = buildConfigurationUrl(scope, 'precomputed')
  const automaticRoots = options?.trustedRootCertificates === undefined
  const roots = [...(options?.trustedRootCertificates ?? bundledRootsForEndpoint(endpoint))]
  if (roots.length > 4 || roots.some((root) => typeof root !== 'string' || root.length > 5464))
    throw new Error('Invalid response signing trust anchors')
  if (mode === 'required' && !roots.length)
    throw new Error('Required response signing needs a locally trusted root certificate')
  const verified = new WeakMap<FlagsConfiguration, { expiresAt: number; acceptedAt: number; context: string }>()
  const serializedScope = JSON.stringify({ version: 1, mode, roots, scope })
  let namespace: Promise<string | undefined> | undefined
  function failure(error: unknown): undefined {
    const reason = error instanceof ResponseVerificationError ? error.reason : 'invalid-proof'
    if (mode === 'required')
      throw error instanceof ResponseVerificationError ? error : new ResponseVerificationError(reason)
    return undefined
  }
  return {
    mode,
    /** Hash the full immutable provider scope only when cache is used; never expose tokens in storage keys. */
    cacheNamespace(): Promise<string | undefined> {
      namespace ??= sha256(utf8(serializedScope)).then(
        (digest) => `response-signing-v1-${hex(digest)}`,
        () => undefined
      )
      return namespace
    },
    prepare(url: string, headers: Record<string, string>, body: string): SigningRequest | undefined {
      try {
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
        // Whole-body proofs require buffered delivery, regardless of the server rollout.
        normalized.set('x-stream', 'false')
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
      } catch (error) {
        return failure(error)
      }
    },
    async read(
      response: Response,
      request: SigningRequest | undefined
    ): Promise<{ json: unknown; proof?: VerifiedResponse }> {
      // A custom fetch may ignore redirect: 'error'. Redirects are transport failures, even in observe mode.
      if (response.redirected) throw new Error('Flag configuration redirects are not supported with response signing')
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
              failure(new ResponseVerificationError('response-too-large'))
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
          roots
        )
      } catch (error) {
        failure(error)
      }
      // Parse failures remain ordinary errors; never treat malformed application JSON as optional crypto failure.
      return { json: JSON.parse(new TextDecoder().decode(bytes)), proof }
    },
    admit(
      config: FlagsConfiguration,
      context: EvaluationContext,
      proof: VerifiedResponse | undefined,
      signal?: AbortSignal
    ): void {
      signal?.throwIfAborted()
      if (proof) {
        if (proof.expiresAt <= Date.now() / 1000 || proof.verifiedAt > Date.now() / 1000) {
          failure(new ResponseVerificationError('expired-proof'))
          return
        }
        verified.set(config, { ...proof, acceptedAt: proof.verifiedAt, context: signingContextKey(context) })
      }
    },
    isExpired(config: FlagsConfiguration | undefined, context: EvaluationContext): boolean {
      const proof = config && verified.get(config)
      return !!proof && proof.expiresAt <= Date.now() / 1000 && proof.context === signingContextKey(context)
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
