import type { FlagsConfiguration, PrecomputedConfigurationResponse } from '@datadog/flagging-core'
import { timeStampNow } from '@datadog/js-core/time'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../domain/configuration'
import { buildEndpointHost } from './endpoint'

const sourcePayload = {
  sdk_name: 'browser',
  sdk_version: __BUILD_ENV__SDK_VERSION__,
}

type JSONAPIError = {
  errors: {
    detail: string
  }[]
}

const REQUEST_TIMEOUT_MS = 1_000
const REQUEST_RETRY_COUNT = 1

class HTTPResponseError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

class RequestTimeoutError extends Error {}

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

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function isRetryableError(error: unknown) {
  return (
    error instanceof RequestTimeoutError ||
    error instanceof TypeError ||
    (error instanceof HTTPResponseError && isRetryableStatus(error.status))
  )
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<PrecomputedConfigurationResponse> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort(callerSignal?.reason)

  if (callerSignal?.aborted) {
    abortFromCaller()
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      let errorMessage: string
      try {
        errorMessage = await getErrorMessage(response)
      } catch (error) {
        if (isRetryableStatus(response.status)) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          throw new HTTPResponseError(message, response.status)
        }
        throw error
      }
      throw new HTTPResponseError(`Failed to fetch flag configuration: ${errorMessage}`, response.status)
    }
    return (await response.json()) as PrecomputedConfigurationResponse
  } catch (error) {
    if (timedOut && !callerSignal?.aborted) {
      throw new RequestTimeoutError('Flag configuration request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  const configuredTimeout = initConfiguration.assignmentRequestTimeoutMs
  const configuredRetryCount = initConfiguration.assignmentRequestRetryCount
  const requestTimeoutMs =
    typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : REQUEST_TIMEOUT_MS
  const requestRetryCount =
    typeof configuredRetryCount === 'number' && Number.isFinite(configuredRetryCount) && configuredRetryCount >= 0
      ? Math.floor(configuredRetryCount)
      : REQUEST_RETRY_COUNT
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

  return async (context: EvaluationContext, { signal }: { signal?: AbortSignal } = {}): Promise<FlagsConfiguration> => {
    // Stringify all context values
    const stringifiedContext: Record<string, string> = {}
    for (const [key, value] of Object.entries(context)) {
      stringifiedContext[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }

    const requestInit: RequestInit = {
      method: 'POST',
      headers: defaultHeaders,
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
    }

    for (let attempt = 0; attempt <= requestRetryCount; attempt += 1) {
      try {
        const precomputed = await fetchWithTimeout(url.toString(), requestInit, requestTimeoutMs, signal)
        return {
          precomputed: {
            response: precomputed,
            context,
            fetchedAt: timeStampNow(),
          },
        }
      } catch (error) {
        if (signal?.aborted || attempt === requestRetryCount || !isRetryableError(error)) {
          throw error
        }
      }
    }

    throw new Error('Flag configuration request retry loop completed unexpectedly')
  }
}
