import { buildEndpointHost, type FlagsConfiguration, timeStampNow } from '@datadog/flagging-core'
import { configurationFromRulesBinary } from '@datadog/flagging-core/rules-based'

interface ConfigurationFetchOptions {
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
  if (signal?.aborted) throw abortError(signal)

  const url = new URL(`https://${host}/api/v2/feature-flagging/config/rules-based/${distributionChannel}`)
  url.searchParams.set('dd_env', env)

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
      response = await requestFetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/protobuf',
          [distributionChannel === 'client' ? 'dd-client-token' : 'dd-api-key']: credential,
          'DD-Client-Library-Language': 'nodejs',
          'DD-Client-Library-Version': __BUILD_ENV__SDK_VERSION__,
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
