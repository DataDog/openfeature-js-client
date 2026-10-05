import { buildEndpointHost, type FlagsConfiguration, timeStampNow } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'

interface ConfigurationFetchOptions {
  env: string
  /** Datadog site. Defaults to datadoghq.com. */
  site?: string
  /** Request and body-read timeout in milliseconds. Defaults to 2000. */
  timeoutMs?: number
  /** Maximum decoded HTTP response size in bytes. Defaults to 10 MiB. */
  maxResponseBytes?: number
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
  | 'invalid_options'
  | 'http'
  | 'invalid_response'
  | 'response_too_large'
  | 'decode'
  | 'transport'
  | 'timeout'
  | 'cancelled'

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
    timeoutMs = 2000,
    maxResponseBytes = 10 * 1024 * 1024,
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
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2147483647 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
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
  const timer = setTimeout(
    () => controller.abort(new ConfigurationFetchError('timeout', 'Configuration fetch timed out')),
    timeoutMs
  )
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

    const bytes = await readResponse(response, maxResponseBytes)
    controller.signal.throwIfAborted()
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
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    // Aborting also releases an unfinished response after a validation or size-limit failure.
    controller.abort()
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {})
  }
}

async function readResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    throw new ConfigurationFetchError('response_too_large', 'Configuration response exceeds the size limit')
  }
  if (!response.body) throw new ConfigurationFetchError('invalid_response', 'Configuration response was empty')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        throw new ConfigurationFetchError('transport', 'Configuration response could not be read')
      }
      if (result.done) break
      size += result.value.byteLength
      if (size > limit) {
        throw new ConfigurationFetchError('response_too_large', 'Configuration response exceeds the size limit')
      }
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  if (size === 0) throw new ConfigurationFetchError('invalid_response', 'Configuration response was empty')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
