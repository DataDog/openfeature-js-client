import {
  buildEndpointHost,
  canonicalizeFlagSelection,
  type FlagSelection,
  type FlagSelectionError,
  type FlagsConfiguration,
  MAX_FLAG_SELECTION_KEY_PATTERN_BYTES,
  MAX_FLAG_SELECTION_TAG_BYTES,
  MAX_FLAG_SELECTION_VALUES,
  timeStampNow,
} from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'

interface ConfigurationFetchOptions {
  env: string
  /** Datadog site. Defaults to datadoghq.com. */
  site?: string
  /**
   * Request flags matching any of these tags or key patterns.
   * Best-effort: an invalid or over-limit selection is not sent.
   */
  flagSelection?: FlagSelection
  /**
   * Service to attribute Feature Flags usage to, sent as DD-Service with the server distribution channel only.
   * Best-effort: a name outside the format Datadog accepts is not sent.
   */
  service?: string
  /** Reports a dropped service and dropped or server-ignored selections. Defaults to console. */
  logger?: { error(message: string): void }
  /** Request and response-body deadline in milliseconds. Defaults to 5000. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Fetch-compatible transport. Must honor the supplied signal and redirect policy. */
  fetch?: typeof globalThis.fetch
}

export type RulesConfigurationFetchOptions = ConfigurationFetchOptions &
  (
    | { distributionChannel?: 'server'; apiKey: string; clientToken?: never }
    | { distributionChannel: 'client'; clientToken: string; apiKey?: never }
  )

export type ConfigurationFetchErrorCode =
  'invalid_options' | 'http' | 'invalid_response' | 'decode' | 'transport' | 'cancelled' | 'timeout'

/** A configuration-loading failure, not an OpenFeature evaluation error. */
export class ConfigurationFetchError extends Error {
  constructor(
    readonly code: ConfigurationFetchErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ConfigurationFetchError'
  }
}

function abortError(signal?: AbortSignal): ConfigurationFetchError {
  return signal?.reason?.name === 'TimeoutError'
    ? new ConfigurationFetchError('timeout', 'Configuration fetch timed out')
    : new ConfigurationFetchError('cancelled', 'Configuration fetch cancelled')
}

// Raw errors can contain credentials or response bytes. Copy only a fixed diagnostic code.
const TRANSPORT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function transportError(message: string, error: unknown): ConfigurationFetchError {
  const { code, cause } = (error ?? {}) as { code?: unknown; cause?: { code?: unknown } }
  const known = [cause?.code, code].find((value) => typeof value === 'string' && TRANSPORT_CODES.has(value))
  return new ConfigurationFetchError('transport', known ? `${message} (${known})` : message)
}

function invalidOption(option: string): ConfigurationFetchError {
  return new ConfigurationFetchError('invalid_options', `Invalid configuration fetch options: ${option}`)
}

// Fastly answers URLs over 8 KB with 414 URI Too Long: https://docs.fastly.com/products/network-services-resource-limits
// Keep URL encoding and this limit in sync with packages/browser/src/transport/flagSelection.ts.
const MAX_RULES_URL_BYTES = 8192

const SELECTION_LIMIT_DESCRIPTIONS: Record<FlagSelectionError, string> = {
  malformed_selection: 'flagSelection must be an object with optional tags and keyPatterns string arrays',
  too_many_values: `each list accepts at most ${MAX_FLAG_SELECTION_VALUES} values`,
  invalid_key_pattern: `each key pattern is at most ${MAX_FLAG_SELECTION_KEY_PATTERN_BYTES} UTF-8 bytes`,
  invalid_tag: `each tag is at most ${MAX_FLAG_SELECTION_TAG_BYTES} UTF-8 bytes`,
}

function reportDiagnostic(logger: NonNullable<ConfigurationFetchOptions['logger']>, message: string): void {
  try {
    logger.error(message)
  } catch {
    // Diagnostics must not prevent configuration loading or replace a fetch error.
  }
}

// The CDN attributes usage to a DD-Service value only in this format, and drops any other.
const USAGE_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/

/**
 * Selects the service sent as DD-Service. A value the CDN would drop is not sent: fetch also rejects header
 * values with CR/LF or characters outside Latin-1, which would fail the whole configuration request.
 */
function usageService(service: unknown, logger: NonNullable<ConfigurationFetchOptions['logger']>): string | undefined {
  if (typeof service === 'string' && USAGE_SERVICE_PATTERN.test(service)) return service
  if (service !== undefined && service !== null && service !== '') {
    reportDiagnostic(
      logger,
      'service does not match the format the CDN attributes usage to; DD-Service header not sent.'
    )
  }
  return undefined
}

function applyFlagSelection(
  url: URL,
  input: FlagSelection | undefined,
  logger: NonNullable<ConfigurationFetchOptions['logger']>
): { url: URL; selected: boolean } {
  const drop = (reason: FlagSelectionError, limit = SELECTION_LIMIT_DESCRIPTIONS[reason]) => {
    reportDiagnostic(logger, `flagSelection was not sent (${reason}: ${limit}). Loading the full flag configuration.`)
    return { url, selected: false }
  }
  try {
    const { selection, error } = canonicalizeFlagSelection(input)
    if (error) return drop(error)
    if (!selection) return { url, selected: false }
    const params = [
      ...selection.tags.map((tag) => `selected_flag_tags=${encodeQueryValue(tag)}`),
      ...selection.keyPatterns.map((pattern) => `selected_flag_key_patterns=${encodeQueryValue(pattern)}`),
    ]
    const selectedUrl = new URL(url.toString())
    selectedUrl.search = [selectedUrl.search.slice(1), ...params].filter(Boolean).join('&')

    // Percent-encoding makes the serialized URL ASCII, so its length is its byte length.
    if (selectedUrl.toString().length > MAX_RULES_URL_BYTES) {
      return drop('too_many_values', `the request URL is at most ${MAX_RULES_URL_BYTES} bytes`)
    }
    return { url: selectedUrl, selected: true }
  } catch {
    // Getters, proxies, and encoding failures can expose caller data through raw errors.
    return drop('malformed_selection')
  }
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Fetch and parse context-independent rules without initializing a provider or tracer.
 * Only client-distributed configurations are suitable for forwarding to a browser.
 */
export async function fetchRulesConfiguration(options: RulesConfigurationFetchOptions): Promise<FlagsConfiguration> {
  const {
    distributionChannel = 'server',
    apiKey,
    clientToken,
    env,
    site = 'datadoghq.com',
    flagSelection,
    service,
    logger = console,
    timeoutMs = 5000,
    signal,
    fetch: requestFetch = globalThis.fetch,
  } = options ?? {}
  if (!['server', 'client'].includes(distributionChannel)) throw invalidOption('distributionChannel')
  if (distributionChannel === 'client' ? apiKey !== undefined : clientToken !== undefined) {
    throw invalidOption(
      distributionChannel === 'client'
        ? 'apiKey with client distribution channel'
        : 'clientToken with server distribution channel'
    )
  }
  const credential = distributionChannel === 'client' ? clientToken : apiKey
  if (typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential)) {
    throw invalidOption(distributionChannel === 'client' ? 'clientToken' : 'apiKey')
  }
  if (typeof env !== 'string' || !env.trim()) throw invalidOption('env')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw invalidOption('timeoutMs')
  if (typeof requestFetch !== 'function') throw invalidOption('fetch')
  if (!logger || typeof logger.error !== 'function') throw invalidOption('logger')
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw invalidOption('signal')
  }
  let host: string
  try {
    host = buildEndpointHost(site, `ufc-${distributionChannel}`)
  } catch {
    throw invalidOption('site')
  }
  const url = new URL(`https://${host}/api/v2/feature-flagging/config/rules-based/${distributionChannel}`)
  url.searchParams.set('dd_env', env)
  const { url: requestUrl, selected } = applyFlagSelection(url, flagSelection, logger)
  const serviceHeader = distributionChannel === 'server' ? usageService(service, logger) : undefined
  if (signal?.aborted) throw abortError(signal)

  const controller = new AbortController()
  const cancel = () => controller.abort(abortError(signal))
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new ConfigurationFetchError('timeout', 'Configuration fetch timed out')),
    timeoutMs
  )
  const fetchedAt = timeStampNow()
  let response: Response | undefined
  try {
    try {
      response = await requestFetch(requestUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/protobuf',
          [distributionChannel === 'client' ? 'dd-client-token' : 'dd-api-key']: credential,
          'DD-Client-Library-Language': 'nodejs',
          'DD-Client-Library-Version': __BUILD_ENV__SDK_VERSION__,
          // Lets the CDN attribute this request's usage to the service.
          ...(serviceHeader ? { 'DD-Service': serviceHeader } : {}),
        },
        signal: controller.signal,
        // Never forward a credential to a redirect destination.
        redirect: 'manual',
      })
    } catch (error) {
      throw transportError('Configuration request failed', error)
    }
    controller.signal.throwIfAborted()
    if (response.status !== 200) {
      throw new ConfigurationFetchError('http', `Configuration fetch returned HTTP ${response.status}`, response.status)
    }
    if (selected) {
      const reason = response.headers.get('DD-Flag-Selection-Ignored')
      if (reason) {
        reportDiagnostic(
          logger,
          `flagSelection was ignored by the server (${reason}). Loaded the full flag configuration.`
        )
      }
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/protobuf') {
      throw new ConfigurationFetchError('invalid_response', 'Expected a protobuf configuration response')
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      throw transportError('Configuration response could not be read', error)
    }
    controller.signal.throwIfAborted()
    if (bytes.length === 0) throw new ConfigurationFetchError('invalid_response', 'Configuration response was empty')
    let configuration: FlagsConfiguration
    try {
      configuration = configurationFromRulesBinary(bytes)
    } catch {
      throw new ConfigurationFetchError('decode', 'Configuration protobuf could not be decoded')
    }
    if (configuration.rules) {
      configuration.rules.fetchedAt = fetchedAt
      const etag = response.headers.get('etag')
      if (etag !== null) configuration.rules.etag = etag
    }
    return configuration
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof ConfigurationFetchError) throw error
    throw transportError('Configuration request failed', error)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
    // Aborting also releases an unfinished response after a validation failure.
    controller.abort()
    // Custom transports can use Web streams or Node streams (for example, node-fetch).
    // Cleanup must not replace the result or delay it if cancellation never settles.
    try {
      const body = response?.body as (ReadableStream & { destroy?: () => void }) | null | undefined
      if (body && !response?.bodyUsed) {
        if (typeof body.cancel === 'function') void body.cancel().catch(() => {})
        else body.destroy?.()
      }
    } catch {
      // Ignore synchronous cleanup failures from custom transports as well.
    }
  }
}
