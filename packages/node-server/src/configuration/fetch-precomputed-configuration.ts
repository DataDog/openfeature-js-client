import {
  acknowledgesExperimentationOptOut,
  buildEndpointHost,
  type CanonicalFlagSelection,
  type ClientFingerprint,
  canonicalizeFlagSelection,
  type ExperimentationOptOutModeValue,
  experimentationOptOutPolicy,
  FLAG_KEY_SHA256_CAPABILITY,
  type FlagsConfiguration,
  parsePrecomputedConfigurationResponse,
} from '@datadog/flagging-core'
import type { EvaluationContext, JsonValue } from '@openfeature/core'
import { readPrecomputedCapabilities } from './client-fingerprint'
import {
  ConfigurationFetchError,
  type ConfigurationTransportOptions,
  invalidOption,
  requestConfiguration,
  transportError,
  validateTransportOptions,
} from './configuration-fetch'
import {
  type ConfigurationSelectionOptions,
  reportDroppedFlagSelection,
  reportIgnoredFlagSelection,
} from './flag-selection'

export interface PrecomputedConfigurationFetchOptions
  extends ConfigurationTransportOptions, ConfigurationSelectionOptions {
  /** Required for now. Only client-distributed flags are supported by this endpoint. */
  distributionChannel: 'client'
  clientToken: string
  /** Reserved. API-key authentication is not supported for client distribution. */
  apiKey?: never
  env: string
  /** Datadog site. Defaults to datadoghq.com. */
  site?: string
  applicationId?: string
  /**
   * A detached snapshot is bound to the returned assignments. Only plain JSON values are accepted:
   * no Date, undefined, non-finite numbers, class instances, or cycles, including nested values.
   * Convert dates to strings before calling and use the same context in the receiving provider.
   */
  context: EvaluationContext
  /** Opaque target SDK fingerprint. Forward unchanged from its getter; omission requests plaintext. */
  clientFingerprint?: ClientFingerprint
  /** Defaults to disabled. The receiving provider must use the same effective opt-out policy. */
  experimentationOptOutMode?: ExperimentationOptOutModeValue
}

/** Fetch assignments for one client context, without initializing a provider or emitting tracking events. */
export async function fetchPrecomputedConfiguration(
  options: PrecomputedConfigurationFetchOptions
): Promise<FlagsConfiguration> {
  let validated: ReturnType<typeof validateOptions>
  try {
    validated = validateOptions(options)
  } catch (error) {
    if (error instanceof ConfigurationFetchError) throw error
    throw invalidOption('precomputed configuration')
  }
  const {
    url,
    clientToken,
    applicationId,
    env,
    context,
    capabilities,
    optOut,
    flagSelection,
    logger,
    requestFetch,
    timeoutMs,
    signal,
  } = validated
  const body = JSON.stringify({
    data: {
      type: 'precompute-assignments-request',
      attributes: {
        env: { dd_env: env },
        source: { sdk_name: 'nodejs', sdk_version: __BUILD_ENV__SDK_VERSION__ },
        ...(optOut && { evaluation_options: { experimentation_opt_out_mode: optOut.mode } }),
        ...(flagSelection && {
          flag_selection: { tags: flagSelection.tags, key_patterns: flagSelection.keyPatterns },
        }),
        subject: {
          targeting_key: context.targetingKey || '',
          targeting_attributes: Object.fromEntries(
            Object.entries(context).map(([key, value]) => [
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            ])
          ),
        },
      },
    },
  })
  return requestConfiguration(
    url.toString(),
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'dd-client-token': clientToken,
        ...(applicationId !== undefined && { 'dd-application-id': applicationId }),
        ...(capabilities.length > 0 && { 'X-DD-FEATURE-FLAGS-CAPABILITIES': capabilities.join(',') }),
      },
      body,
    },
    { fetch: requestFetch, timeoutMs, signal },
    async (response, fetchedAt, checkAborted) => {
      if (flagSelection) reportIgnoredFlagSelection(logger, response)
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json' && contentType !== 'application/vnd.api+json') {
        throw new ConfigurationFetchError('invalid_response', 'Expected a JSON configuration response')
      }
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        throw transportError('Configuration response could not be read', error)
      }
      checkAborted()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new ConfigurationFetchError('decode', 'Configuration JSON could not be decoded')
      }
      const parsed = parsePrecomputedConfigurationResponse(json)
      if ('error' in parsed) throw new ConfigurationFetchError('decode', 'Invalid precomputed configuration response')
      if (!acknowledgesExperimentationOptOut({ precomputed: parsed }, optOut)) {
        throw new ConfigurationFetchError(
          'decode',
          'The assignment response did not acknowledge experimentation opt-out'
        )
      }
      if (parsed.response.data.attributes.obfuscated === true && !capabilities.includes(FLAG_KEY_SHA256_CAPABILITY)) {
        throw new ConfigurationFetchError('decode', 'Configuration encoding was not advertised by the target client')
      }
      const etag = response.headers.get('etag')
      return { precomputed: { ...parsed, context, fetchedAt, ...(etag !== null && { etag }) } }
    }
  )
}

function validateOptions(options: PrecomputedConfigurationFetchOptions) {
  const {
    distributionChannel,
    clientToken,
    apiKey,
    env,
    site = 'datadoghq.com',
    applicationId,
    context: inputContext,
    clientFingerprint,
    experimentationOptOutMode = 'disabled',
    flagSelection: inputSelection,
    logger = console,
    timeoutMs = 5000,
    signal,
    fetch: requestFetch = globalThis.fetch,
  } = options ?? {}
  if (distributionChannel !== 'client') throw invalidOption('distributionChannel')
  if (apiKey !== undefined) throw invalidOption('apiKey with client distribution channel')
  if (
    experimentationOptOutMode !== 'disabled' &&
    experimentationOptOutMode !== 'immediate' &&
    experimentationOptOutMode !== 'future_experiments_only'
  ) {
    throw invalidOption('experimentationOptOutMode')
  }
  if (typeof clientToken !== 'string' || !clientToken.trim() || /[\r\n]/.test(clientToken))
    throw invalidOption('clientToken')
  if (typeof env !== 'string' || !env.trim()) throw invalidOption('env')
  if (
    applicationId !== undefined &&
    (typeof applicationId !== 'string' || !applicationId.trim() || /[\r\n]/.test(applicationId))
  ) {
    throw invalidOption('applicationId')
  }
  validateTransportOptions(timeoutMs, signal, requestFetch)
  if (!logger || typeof logger.error !== 'function') throw invalidOption('logger')
  let host: string
  try {
    host = buildEndpointHost(site, 'preview')
  } catch {
    throw invalidOption('site')
  }
  let capabilities: readonly string[]
  try {
    capabilities = readPrecomputedCapabilities(clientFingerprint)
  } catch {
    throw invalidOption('clientFingerprint')
  }
  let context: EvaluationContext
  try {
    if (!isRecord(inputContext)) throw new Error('Invalid context')
    context = cloneJson(inputContext) as EvaluationContext
  } catch {
    throw invalidOption('context (must contain only plain JSON values; convert dates to strings)')
  }
  if (context.targetingKey !== undefined && typeof context.targetingKey !== 'string')
    throw invalidOption('context.targetingKey (must be a string)')
  const optOut = experimentationOptOutPolicy(context, experimentationOptOutMode)
  if (optOut === undefined) throw invalidOption('context.dd_experimentation_opt_out_at')
  let flagSelection: CanonicalFlagSelection | undefined
  try {
    const { selection, error } = canonicalizeFlagSelection(inputSelection)
    if (error) reportDroppedFlagSelection(logger, error)
    else flagSelection = selection
  } catch {
    // Getters and proxies can expose caller data through raw errors.
    reportDroppedFlagSelection(logger, 'malformed_selection')
  }
  const url = new URL(`https://${host}/precompute-assignments`)
  url.searchParams.set('dd_env', env)
  return {
    url,
    clientToken,
    applicationId,
    env,
    context,
    capabilities,
    optOut,
    flagSelection,
    logger,
    requestFetch,
    timeoutMs,
    signal,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

// Detach the request context so later caller mutations cannot relabel the returned assignments.
function cloneJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('Invalid JSON value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (entry) => cloneJson(entry, ancestors))
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry, ancestors)]))
    throw new Error('Invalid JSON value')
  } finally {
    ancestors.delete(value)
  }
}
