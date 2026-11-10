import {
  buildEndpointHost,
  canonicalizeFlagSelection,
  type FlagSelection,
  type FlagSelectionError,
  type FlagsConfiguration,
} from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'
import {
  ConfigurationFetchError,
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

export { ConfigurationFetchError, type ConfigurationFetchErrorCode } from './configuration-fetch'

interface ConfigurationFetchOptions extends ConfigurationSelectionOptions {
  env: string
  /** Datadog site. Defaults to datadoghq.com. */
  site?: string
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

// Fastly answers URLs over 8 KB with 414 URI Too Long: https://docs.fastly.com/products/network-services-resource-limits
// Keep URL encoding and this limit in sync with packages/browser/src/transport/flagSelection.ts.
const MAX_RULES_URL_BYTES = 8192

function applyFlagSelection(
  url: URL,
  input: FlagSelection | undefined,
  logger: NonNullable<ConfigurationFetchOptions['logger']>
): { url: URL; selected: boolean } {
  const drop = (reason: FlagSelectionError, limit?: string) => {
    reportDroppedFlagSelection(logger, reason, limit)
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
  validateTransportOptions(timeoutMs, signal, requestFetch)
  if (!logger || typeof logger.error !== 'function') throw invalidOption('logger')
  let host: string
  try {
    host = buildEndpointHost(site, `ufc-${distributionChannel}`)
  } catch {
    throw invalidOption('site')
  }
  const url = new URL(`https://${host}/api/v2/feature-flagging/config/rules-based/${distributionChannel}`)
  url.searchParams.set('dd_env', env)
  const { url: requestUrl, selected } = applyFlagSelection(url, flagSelection, logger)
  return requestConfiguration(
    requestUrl.toString(),
    {
      method: 'GET',
      headers: {
        Accept: 'application/protobuf',
        [distributionChannel === 'client' ? 'dd-client-token' : 'dd-api-key']: credential,
        'DD-Client-Library-Language': 'nodejs',
        'DD-Client-Library-Version': __BUILD_ENV__SDK_VERSION__,
      },
    },
    { fetch: requestFetch, timeoutMs, signal },
    async (response, fetchedAt, checkAborted) => {
      if (selected) reportIgnoredFlagSelection(logger, response)
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
      checkAborted()
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
    }
  )
}
