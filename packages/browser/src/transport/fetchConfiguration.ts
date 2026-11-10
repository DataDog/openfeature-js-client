import {
  acknowledgesExperimentationOptOut,
  buildEndpointHost,
  type CanonicalFlagSelection,
  canonicalizeFlagSelection,
  experimentationOptOutPolicy,
  type FlagSelection,
  type FlagsConfiguration,
  INVALID_EXPERIMENTATION_OPT_OUT,
  parsePrecomputedConfigurationResponse,
  SUPPORTED_FLAGS_CAPABILITIES,
} from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import { InvalidContextError, ParseError } from '@openfeature/web-sdk'
import { createDebugLogger, type DebugConfiguration, type DebugLogger, debugForSignal, NO_DEBUG } from '../debug'
import {
  ASSIGNMENT_AUTHORIZATION_FAILED,
  ASSIGNMENT_TOKEN_HEADER,
  assignmentAuthorizationError,
  extractAssignmentToken,
  normalizeAssignmentToken,
} from '../domain/assignment-token'
import type { FlaggingInitConfiguration } from '../domain/configuration'
import {
  type ExperimentationOptOutConfiguration,
  getExperimentationOptOutMode,
} from '../openfeature/experimentation-opt-out'
import { debugFetch } from './debugFetch'
import { reportDroppedFlagSelection, reportIgnoredFlagSelection } from './flagSelection'
import { serializeRequestBody } from './requestDiagnostics'

const sourcePayload = {
  sdk_name: 'browser',
  sdk_version: __BUILD_ENV__SDK_VERSION__,
}
const capabilitiesHeader = [...SUPPORTED_FLAGS_CAPABILITIES].sort().join(',')

type JSONAPIError = {
  errors: {
    detail: string
  }[]
}

interface ConfigurationRequestOptions {
  clientToken: string
  applicationId?: string
  env?: string | null
  site?: string
  customHeaders?: Record<string, string>
  overwriteRequestHeaders?: boolean
  flaggingProxy?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

interface ConfigurationFetchOptions extends DebugConfiguration {
  clientToken: string
  env: string
  site?: string
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

export interface PrecomputedConfigurationFetchOptions
  extends ConfigurationFetchOptions, ExperimentationOptOutConfiguration {
  applicationId?: string
  context: EvaluationContext
}

export interface RulesConfigurationFetchOptions extends ConfigurationFetchOptions {
  /**
   * Load only the flags that match these tags or key patterns. See the README for the matching rules and limits.
   * A selection over a limit is not sent, and the full configuration is loaded.
   */
  flagSelection?: FlagSelection
}

export async function getErrorMessage(response: Response) {
  if (
    response.headers?.get('content-type') === 'application/vnd.api+json' ||
    response.headers?.get('content-type') === 'application/json'
  ) {
    const error = (await response.json()) as JSONAPIError
    if ('errors' in error) {
      return error.errors[0].detail
    }
    return 'Unknown error'
  }
  return response.statusText || 'Unknown error'
}

export function buildConfigurationUrl(options: ConfigurationRequestOptions, endpoint: 'precomputed' | 'rules'): URL {
  let url: URL
  if (options.flaggingProxy?.match('https?://')) {
    // If flaggingProxy has a protocol, use it as-is
    url = new URL(`${options.flaggingProxy}`)
  } else if (options.flaggingProxy) {
    // Otherwise, prepend https:// to the proxy
    url = new URL(`https://${options.flaggingProxy}`)
  } else {
    const host = buildEndpointHost(options.site || 'datadoghq.com', endpoint === 'rules' ? 'ufc-client' : 'preview')
    url = new URL(
      endpoint === 'rules'
        ? `https://${host}/api/v2/feature-flagging/config/rules-based/client`
        : `https://${host}/precompute-assignments`
    )
  }

  url.searchParams.set('dd_env', options.env || '')
  return url
}

export function buildConfigurationHeaders(
  options: ConfigurationRequestOptions,
  contentHeaders: Record<string, string>,
  endpoint: 'precomputed' | 'rules'
): Record<string, string> {
  return {
    ...contentHeaders,
    ...(options.overwriteRequestHeaders
      ? {}
      : {
          'dd-client-token': options.clientToken,
          ...(endpoint === 'precomputed' && options.applicationId && { 'dd-application-id': options.applicationId }),
          ...(endpoint === 'rules' && {
            'DD-Client-Library-Language': sourcePayload.sdk_name,
            'DD-Client-Library-Version': sourcePayload.sdk_version,
          }),
        }),
    ...options.customHeaders,
  }
}

export async function fetchPrecomputedConfiguration(
  options: PrecomputedConfigurationFetchOptions
): Promise<FlagsConfiguration> {
  return requestPrecomputedConfiguration(
    options,
    undefined,
    createDebugLogger(options.debugMode, 'configuration_fetch')
  )
}

async function requestPrecomputedConfiguration(
  options: PrecomputedConfigurationFetchOptions,
  flagSelection?: CanonicalFlagSelection,
  debug: DebugLogger = NO_DEBUG,
  contextAssignmentToken?: unknown
): Promise<FlagsConfiguration> {
  // Also sanitize the standalone fetch API; it can be used without a provider.
  const extracted = extractAssignmentToken(options.context)
  const assignmentToken = normalizeAssignmentToken(
    contextAssignmentToken !== undefined ? contextAssignmentToken : extracted.assignmentToken
  )
  options = { ...options, context: extracted.context }
  debug.event('context.received', () => ({ context: options.context }))
  const optedOut = experimentationOptOutPolicy(options.context, getExperimentationOptOutMode(options, debug))
  if (optedOut === undefined) {
    debug.event('context.invalid', () => ({ context: options.context, reason: INVALID_EXPERIMENTATION_OPT_OUT }))
    throw new InvalidContextError(INVALID_EXPERIMENTATION_OPT_OUT)
  }
  const requestOptions: ConfigurationRequestOptions = options
  const url = buildConfigurationUrl(requestOptions, 'precomputed')
  const fetchedAt = timeStampNow()
  const defaultHeaders = buildConfigurationHeaders(
    options,
    {
      'Content-Type': 'application/vnd.api+json',
      // Customer proxies can opt in through customHeaders after allowing it in CORS.
      ...(!requestOptions.flaggingProxy && { 'X-DD-FEATURE-FLAGS-CAPABILITIES': capabilitiesHeader }),
    },
    'precomputed'
  )

  // Context is the sole source of this reserved header, including on removal.
  for (const name of Object.keys(defaultHeaders)) {
    if (name.toLowerCase() === ASSIGNMENT_TOKEN_HEADER.toLowerCase()) delete defaultHeaders[name]
  }
  if (assignmentToken !== undefined) defaultHeaders[ASSIGNMENT_TOKEN_HEADER] = assignmentToken

  const envPayload = {
    dd_env: options.env || '',
  }

  // Stringify all context values
  const stringifiedContext: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.context)) {
    try {
      stringifiedContext[key] = typeof value === 'string' ? value : JSON.stringify(value)
    } catch (error) {
      debug.event('context.encoding_failed', () => ({ key, value, type: typeof value, error }))
      throw error
    }
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch
  const targetingKey = options.context.targetingKey || ''
  debug.event('context.normalized', () => ({
    rawContext: options.context,
    normalizedContext: stringifiedContext,
    targetingKey,
    optedOut,
    flagSelection,
    capabilities: capabilitiesHeader,
  }))
  let response: Response
  try {
    response = await debugFetch(
      fetchImplementation,
      url.toString(),
      {
        method: 'POST',
        headers: defaultHeaders,
        signal: options.signal,
        body: serializeRequestBody(
          {
            data: {
              type: 'precompute-assignments-request',
              attributes: {
                env: envPayload,
                source: sourcePayload,
                ...(optedOut && { evaluation_options: { experimentation_opt_out_mode: optedOut.mode } }),
                subject: {
                  targeting_key: targetingKey,
                  targeting_attributes: stringifiedContext,
                },
                ...(flagSelection && {
                  flag_selection: { tags: flagSelection.tags, key_patterns: flagSelection.keyPatterns },
                }),
              },
            },
          },
          options.signal
        ),
      },
      debug,
      assignmentToken !== undefined
    )
  } catch (error) {
    if (assignmentToken === undefined) throw error
    // Custom transports can include request headers in their message, stack,
    // cause or extra properties. Never forward the original error object.
    throw redactAssignmentError(error, new Error('Failed to fetch flag configuration: transport error'))
  }
  if (await isAssignmentAuthorizationRejection(response)) throw assignmentAuthorizationError()
  if (!response.ok) {
    // A proxy may echo request headers in an error body. Do not expose that body
    // through OpenFeature errors when a credential was supplied.
    const errorMessage = assignmentToken === undefined ? await getErrorMessage(response) : `HTTP ${response.status}`
    throw new Error(`Failed to fetch flag configuration: ${errorMessage}`)
  }
  if (flagSelection) reportIgnoredFlagSelection(response, assignmentToken !== undefined)
  let responseBody: unknown
  try {
    responseBody = await response.json()
  } catch (error) {
    if (assignmentToken === undefined) throw error
    // JSON parser errors can quote response text, including echoed credentials.
    throw redactAssignmentError(error, new ParseError('Assignment response is not valid JSON'))
  }
  const parsed = parsePrecomputedConfigurationResponse(responseBody)
  debug.event('configuration.decoded', () => {
    const raw = responseBody as { data?: { attributes?: { flags?: unknown } } } | null
    const receivedFlags = raw?.data?.attributes?.flags
    const receivedKeys = receivedFlags && typeof receivedFlags === 'object' ? Object.keys(receivedFlags) : []
    const rejectedKeys = 'error' in parsed ? receivedKeys : Object.keys(parsed.flagErrors ?? {})
    const rejected = new Set(rejectedKeys)
    const acceptedKeys =
      'error' in parsed ? [] : Object.keys(parsed.response.data.attributes.flags).filter((key) => !rejected.has(key))
    return {
      raw: responseBody,
      parsed,
      outcome: 'error' in parsed ? 'rejected' : 'decoded',
      receivedCount: receivedKeys.length,
      acceptedCount: acceptedKeys.length,
      rejectedCount: rejectedKeys.length,
      acceptedKeys,
      rejectedKeys,
      flagErrors: 'error' in parsed ? undefined : parsed.flagErrors,
      rejectionScope: 'error' in parsed ? 'response' : 'individual_flags',
    }
  })
  if ('error' in parsed) return { precomputedError: parsed.error }
  if (!acknowledgesExperimentationOptOut({ precomputed: parsed }, optedOut)) {
    debug.event('configuration.rejected', () => ({
      reason: 'experimentation_policy_mismatch',
      optedOut,
      response: parsed,
    }))
    throw new ParseError('The assignment response did not acknowledge experimentation opt-out')
  }

  return {
    precomputed: {
      ...parsed,
      context: options.context,
      fetchedAt,
    },
  }
}

function redactAssignmentError(error: unknown, fallback: Error): Error {
  // Preserve cancellation/timeout classification using fixed messages only.
  // Retry wrappers act inside the transport, before this sanitization boundary.
  if (error instanceof Error || error instanceof DOMException) {
    if (error.name === 'AbortError') return new DOMException('Assignment download aborted', 'AbortError')
    if (error.name === 'TimeoutError') return new DOMException('Assignment download timed out', 'TimeoutError')
  }
  return fallback
}

async function isAssignmentAuthorizationRejection(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  try {
    const body: unknown = await response.clone().json()
    return (
      typeof body === 'object' &&
      body !== null &&
      'errors' in body &&
      Array.isArray(body.errors) &&
      body.errors.some(
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === ASSIGNMENT_AUTHORIZATION_FAILED
      )
    )
  } catch {
    // An unrelated or malformed error must retain ordinary HTTP error handling.
    return false
  }
}

export function createFlagsConfigurationFetcher(
  initConfiguration: FlaggingInitConfiguration,
  debug: DebugLogger = NO_DEBUG
) {
  // Validate the endpoint while building the provider, preserving the existing constructor behavior.
  try {
    buildConfigurationUrl(initConfiguration, 'precomputed')
  } catch (error) {
    debug.event('init.failed', () => ({ error, stage: 'endpoint' }))
    throw error
  }
  const { selection: flagSelection, error: flagSelectionError } = canonicalizeFlagSelection(
    initConfiguration.flagSelection
  )
  if (flagSelectionError) reportDroppedFlagSelection(flagSelectionError)
  debug.event('configuration.selection', () => ({
    requested: initConfiguration.flagSelection,
    effective: flagSelection,
    error: flagSelectionError,
  }))
  return async (
    context: EvaluationContext,
    { signal, assignmentToken }: { signal?: AbortSignal; assignmentToken?: unknown } = {}
  ): Promise<FlagsConfiguration> => {
    const configuration = await requestPrecomputedConfiguration(
      {
        ...initConfiguration,
        env: initConfiguration.env || '',
        context,
        fetch: initConfiguration.flagConfigurationFetch,
        signal,
      },
      flagSelection,
      signal ? debugForSignal(signal) : debug,
      assignmentToken
    )
    // Use the provider's existing context-matched cache fallback. Do not replace
    // a valid snapshot with a malformed response or unsupported encoding.
    if (configuration.precomputedError) throw new ParseError(configuration.precomputedError)
    return configuration
  }
}
