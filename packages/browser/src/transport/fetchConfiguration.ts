import type { FlagsConfiguration, PrecomputedConfigurationResponse } from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../domain/configuration'
import { logFeatureFlagsDebug, logFeatureFlagsDebugError } from '../openfeature/debug'
import { buildEndpointHost } from './endpoint'
import { withTimeout } from './fetch'

const DEFAULT_FLAG_CONFIGURATION_REQUEST_TIMEOUT_MS = 30_000

const sourcePayload = {
  sdk_name: 'browser',
  sdk_version: __BUILD_ENV__SDK_VERSION__,
}

type JSONAPIError = {
  errors: {
    detail: string
  }[]
}

async function getErrorMessage(response: Response) {
  if (
    response.headers.get('content-type') === 'application/vnd.api+json' ||
    response.headers.get('content-type') === 'application/json'
  ) {
    const error = (await response.json()) as JSONAPIError
    if ('errors' in error) {
      return error.errors[0].detail
    }
    return 'Unknown error'
  }
  return response.statusText || 'Unknown error'
}

function getRequestErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    if (error.name === 'TimeoutError') {
      return 'request_timeout'
    }
    if (error.name === 'TypeError') {
      return 'network_or_cors_error'
    }
  }
  return 'request_failed'
}

function getHttpErrorCode(status: number): string {
  if (status === 401) {
    return 'authentication_failed'
  }
  if (status === 403) {
    return 'request_forbidden'
  }
  if (status === 408) {
    return 'request_timeout'
  }
  return 'http_error'
}

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  let url: URL
  if (initConfiguration.flaggingProxy?.match('https?://')) {
    // If flaggingProxy has a protocol, use it as-is
    url = new URL(`${initConfiguration.flaggingProxy}`)
  } else if (initConfiguration.flaggingProxy) {
    // Otherwise, prepend https:// to the proxy
    url = new URL(`https://${initConfiguration.flaggingProxy}`)
  } else {
    const host = buildEndpointHost(initConfiguration.site || 'datadoghq.com')
    url = new URL(`https://${host}/precompute-assignments`)
  }

  url.searchParams.set('dd_env', initConfiguration.env || '')

  const defaultHeaders = {
    'Content-Type': 'application/vnd.api+json',
    ...(initConfiguration.overwriteRequestHeaders
      ? {}
      : {
          'dd-client-token': initConfiguration.clientToken,
          ...(initConfiguration.applicationId && { 'dd-application-id': initConfiguration.applicationId }),
        }),
    ...initConfiguration.customHeaders,
  }

  const envPayload = {
    dd_env: initConfiguration.env || '',
  }

  const debugMode = initConfiguration.debugMode ?? false
  const endpoint = `${url.origin}${url.pathname}`

  return async (context: EvaluationContext, { signal }: { signal?: AbortSignal } = {}): Promise<FlagsConfiguration> => {
    const startedAt = Date.now()
    // Stringify all context values
    const stringifiedContext: Record<string, string> = {}
    for (const [key, value] of Object.entries(context)) {
      stringifiedContext[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }

    const fetchImplementation = withTimeout(
      initConfiguration.flagConfigurationFetch ?? globalThis.fetch,
      initConfiguration.flagConfigurationRequestTimeoutMs ?? DEFAULT_FLAG_CONFIGURATION_REQUEST_TIMEOUT_MS
    )
    logFeatureFlagsDebug(debugMode, 'configuration_fetch_started', {
      endpoint,
      request_timeout_ms:
        initConfiguration.flagConfigurationRequestTimeoutMs ?? DEFAULT_FLAG_CONFIGURATION_REQUEST_TIMEOUT_MS,
    })

    let response: Response
    try {
      response = await fetchImplementation(url.toString(), {
        method: 'POST',
        headers: defaultHeaders,
        signal,
        body: JSON.stringify({
          data: {
            type: 'precompute-assignments-request',
            attributes: {
              env: envPayload,
              source: sourcePayload,
              subject: {
                targeting_key: context.targetingKey || '',
                targeting_attributes: stringifiedContext,
              },
            },
          },
        }),
      })
    } catch (error) {
      if (signal?.aborted) {
        logFeatureFlagsDebug(debugMode, 'configuration_fetch_aborted', {
          endpoint,
          request_latency_ms: Math.max(0, Date.now() - startedAt),
        })
      } else {
        logFeatureFlagsDebugError(debugMode, 'configuration_fetch_failed', error, {
          endpoint,
          error_code: getRequestErrorCode(error),
          request_latency_ms: Math.max(0, Date.now() - startedAt),
        })
      }
      throw error
    }
    if (!response.ok) {
      let errorMessage: string
      try {
        errorMessage = await getErrorMessage(response)
      } catch (error) {
        logFeatureFlagsDebugError(debugMode, 'configuration_error_response_parse_failed', error, {
          endpoint,
          http_status_code: response.status,
        })
        throw error
      }
      const error = new Error(`Failed to fetch flag configuration: ${errorMessage}`)
      logFeatureFlagsDebugError(debugMode, 'configuration_fetch_failed', error, {
        endpoint,
        error_code: getHttpErrorCode(response.status),
        http_status_code: response.status,
        request_latency_ms: Math.max(0, Date.now() - startedAt),
      })
      throw error
    }
    let precomputed: unknown
    try {
      precomputed = await response.json()
    } catch (error) {
      logFeatureFlagsDebugError(debugMode, 'configuration_parse_failed', error, {
        endpoint,
        error_code: 'invalid_response',
        http_status_code: response.status,
        request_latency_ms: Math.max(0, Date.now() - startedAt),
      })
      throw error
    }
    logFeatureFlagsDebug(debugMode, 'configuration_fetch_succeeded', {
      endpoint,
      http_status_code: response.status,
      request_latency_ms: Math.max(0, Date.now() - startedAt),
    })
    return {
      precomputed: {
        response: precomputed as PrecomputedConfigurationResponse,
        context,
        fetchedAt: timeStampNow(),
      },
    }
  }
}
