import { dateNow } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../domain/configuration'
import { buildEndpointHost } from './endpoint'

const sdkPayload = {
  name: 'browser',
  version: __BUILD_ENV__SDK_VERSION__,
}

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  let url: URL
  if (initConfiguration.flaggingProxy && initConfiguration.flaggingProxy.match('https?://')) {
    // If flaggingProxy has a protocol, use it as-is
    url = new URL(`${initConfiguration.flaggingProxy}`)
  } else if (initConfiguration.flaggingProxy) {
    // Otherwise, prepend https:// to the proxy
    url = new URL(`https://${initConfiguration.flaggingProxy}`)
  } else {
    const host = buildEndpointHost(initConfiguration.site || 'datadoghq.com')
    url = new URL(`https://${host}/precompute-assignments`)
  }

  if (initConfiguration.env) {
    url.searchParams.set('dd_env', initConfiguration.env)
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
    dd_env: initConfiguration.env || '',
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
            sdk: sdkPayload,
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
