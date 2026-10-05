import { buildEndpointHost, type FlagsConfiguration, timeStampNow } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'

interface ConfigurationFetchOptions {
  env: string
  /** Datadog site. Defaults to datadoghq.com. */
  site?: string
  signal?: AbortSignal
  /** Fetch-compatible transport. Must honor the supplied signal and redirect policy. */
  fetch?: typeof globalThis.fetch
}

export type RulesConfigurationFetchOptions = ConfigurationFetchOptions &
  (
    | { distribution?: 'server'; apiKey: string; clientToken?: never }
    | { distribution: 'client'; clientToken: string; apiKey?: never }
  )

export type ConfigurationFetchErrorCode =
  'invalid_options' | 'http' | 'invalid_response' | 'decode' | 'transport' | 'cancelled'

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

/**
 * Fetch and parse context-independent rules without initializing a provider or tracer.
 * Only client-distributed configurations are suitable for forwarding to a browser.
 */
export async function fetchRulesConfiguration(options: RulesConfigurationFetchOptions): Promise<FlagsConfiguration> {
  const {
    distribution = 'server',
    apiKey,
    clientToken,
    env,
    site = 'datadoghq.com',
    signal,
    fetch: requestFetch = globalThis.fetch,
  } = options ?? {}
  const credential = distribution === 'client' ? clientToken : apiKey
  if (
    !['server', 'client'].includes(distribution) ||
    (distribution === 'client' ? apiKey !== undefined : clientToken !== undefined) ||
    typeof credential !== 'string' ||
    !credential.trim() ||
    /[\r\n]/.test(credential) ||
    typeof env !== 'string' ||
    !env.trim() ||
    typeof requestFetch !== 'function'
  ) {
    throw new ConfigurationFetchError('invalid_options', 'Invalid configuration fetch options')
  }
  let host: string
  try {
    host = buildEndpointHost(site, `ufc-${distribution}`)
  } catch {
    throw new ConfigurationFetchError('invalid_options', 'Invalid configuration fetch options')
  }
  if (signal?.aborted) throw new ConfigurationFetchError('cancelled', 'Configuration fetch cancelled')

  const url = new URL(`https://${host}/api/v2/feature-flagging/config/rules-based/${distribution}`)
  url.searchParams.set('dd_env', env)

  const controller = new AbortController()
  const cancel = () => controller.abort(new ConfigurationFetchError('cancelled', 'Configuration fetch cancelled'))
  signal?.addEventListener('abort', cancel, { once: true })
  const fetchedAt = timeStampNow()
  let response: Response | undefined
  try {
    try {
      response = await requestFetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/protobuf',
          [distribution === 'client' ? 'dd-client-token' : 'dd-api-key']: credential,
          'DD-Client-Library-Language': 'nodejs',
          'DD-Client-Library-Version': __BUILD_ENV__SDK_VERSION__,
        },
        signal: controller.signal,
        // Never forward a credential to a redirect destination.
        redirect: 'manual',
      })
    } catch {
      throw new ConfigurationFetchError('transport', 'Configuration request failed')
    }
    controller.signal.throwIfAborted()
    if (response.status !== 200) {
      throw new ConfigurationFetchError('http', `Configuration fetch returned HTTP ${response.status}`, response.status)
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/protobuf') {
      throw new ConfigurationFetchError('invalid_response', 'Expected a protobuf configuration response')
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      throw new ConfigurationFetchError('transport', 'Configuration response could not be read')
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
    // Transport errors and response bodies can contain credentials. Do not attach them as causes.
    throw new ConfigurationFetchError('transport', 'Configuration request failed')
  } finally {
    signal?.removeEventListener('abort', cancel)
    // Aborting also releases an unfinished response after a validation failure.
    controller.abort()
    // Custom stream cleanup must not delay the result, even if cancellation never settles.
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {})
  }
}
