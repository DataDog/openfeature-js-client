import { dateNow } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../domain/configuration'

function buildEndpointHost(site: string, custDomain = 'preview'): string {
  switch (site) {
    case 'datad0g.com':
      return `${custDomain}.ff-cdn.datad0g.com`
    case 'datadoghq.com':
      return `${custDomain}.ff-cdn.datadoghq.com`
    case 'us3.datadoghq.com':
      return `${custDomain}.ff-cdn.us3.datadoghq.com`
    case 'us5.datadoghq.com':
      return `${custDomain}.ff-cdn.us5.datadoghq.com`
    case 'ap1.datadoghq.com':
      return `${custDomain}.ff-cdn.ap1.datadoghq.com`
    case 'ap2.datadoghq.com':
      return `${custDomain}.ff-cdn.ap2.datadoghq.com`
    case 'datadoghq.eu':
      return `${custDomain}.ff-cdn.datadoghq.eu`
    case 'ddog-gov.com':
      throw new Error('ddog-gov.com is not supported for flagging endpoints')
    default:
      return `${custDomain}.ff-cdn.${site}`
  }
}

const endpointPath = '/precompute-assignments'

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  const host = initConfiguration.flaggingProxy || buildEndpointHost(initConfiguration.site || 'datadoghq.com')

  let url: URL
  if (initConfiguration.flaggingProxy && (host.startsWith('http://') || host.startsWith('https://'))) {
    // If flaggingProxy has a protocol, use it as-is
    url = new URL(`${host}${endpointPath}`)
  } else {
    // Otherwise, prepend https://
    url = new URL(`https://${host}${endpointPath}`)
  }

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
    name: initConfiguration.env,
    dd_env: initConfiguration.env,
  }

  return async (context: EvaluationContext): Promise<FlagsConfiguration> => {
    // Stringify all context values
    const stringifiedContext: Record<string, string> = {}
    for (const [key, value] of Object.entries(context)) {
      stringifiedContext[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        data: {
          type: 'precompute-assignments-request',
          attributes: {
            env: envPayload,
            subject: {
              targeting_key: context.targetingKey || '',
              targeting_attributes: stringifiedContext,
            },
          },
        },
      }),
    })
    const precomputed = await response.json()
    return {
      precomputed: {
        response: precomputed,
        context,
        fetchedAt: dateNow(),
      },
    }
  }
}
