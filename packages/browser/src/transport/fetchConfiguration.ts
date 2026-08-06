import { configMatchesContext, type FlagsConfiguration } from '@datadog/flagging-core'
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

export interface ConfigurationFetchOptions {
  clientToken: string
  applicationId?: string
  env?: string | null
  site?: string
  customHeaders?: Record<string, string>
  overwriteRequestHeaders?: boolean
  flaggingProxy?: string
  signal?: AbortSignal
  previousConfiguration?: FlagsConfiguration
}

export interface PrecomputedConfigurationFetchOptions extends ConfigurationFetchOptions {
  context: EvaluationContext
}

export type RulesConfigurationFetchOptions = ConfigurationFetchOptions

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

export function buildConfigurationUrl(options: ConfigurationFetchOptions, endpoint: 'precomputed' | 'rules'): URL {
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
  options: ConfigurationFetchOptions,
  contentHeaders: Record<string, string>
): Record<string, string> {
  return {
    ...contentHeaders,
    ...(options.overwriteRequestHeaders
      ? {}
      : {
          'dd-client-token': options.clientToken,
          ...(options.applicationId && { 'dd-application-id': options.applicationId }),
        }),
    ...options.customHeaders,
  }
}

export async function fetchPrecomputedConfiguration(
  options: PrecomputedConfigurationFetchOptions
): Promise<FlagsConfiguration> {
  const url = buildConfigurationUrl(options, 'precomputed')
  const defaultHeaders = buildConfigurationHeaders(options, {
    'Content-Type': 'application/vnd.api+json',
    ...(options.previousConfiguration?.precomputed?.etag && {
      'If-None-Match': options.previousConfiguration.precomputed.etag,
    }),
  })

  const envPayload = {
    dd_env: options.env || '',
  }

  // Stringify all context values
  const stringifiedContext: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.context)) {
    stringifiedContext[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: defaultHeaders,
    signal: options.signal,
    body: JSON.stringify({
      data: {
        type: 'precompute-assignments-request',
        attributes: {
          env: envPayload,
          source: sourcePayload,
          subject: {
            targeting_key: options.context.targetingKey || '',
            targeting_attributes: stringifiedContext,
          },
        },
      },
    }),
  })
  if (response.status === 304 && options.previousConfiguration?.precomputed) {
    return { precomputed: options.previousConfiguration.precomputed }
  }
  if (!response.ok) {
    const errorMessage = await getErrorMessage(response)
    throw new Error(`Failed to fetch flag configuration: ${errorMessage}`)
  }
  const precomputed = await response.json()
  const etag = response.headers?.get('etag')
  return {
    precomputed: {
      response: precomputed,
      context: options.context,
      fetchedAt: timeStampNow(),
      ...(etag && { etag }),
    },
  }
}

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  // Validate the endpoint while building the provider, preserving the existing constructor behavior.
  buildConfigurationUrl(initConfiguration, 'precomputed')
  let previousConfiguration: FlagsConfiguration | undefined
  return async (context: EvaluationContext, { signal }: { signal?: AbortSignal } = {}): Promise<FlagsConfiguration> => {
    const configuration = await fetchPrecomputedConfiguration({
      ...initConfiguration,
      context,
      signal,
      previousConfiguration: configMatchesContext(previousConfiguration, context) ? previousConfiguration : undefined,
    })
    previousConfiguration = configuration
    return configuration
  }
}
