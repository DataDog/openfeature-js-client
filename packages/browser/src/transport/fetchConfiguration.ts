import { dateNow } from '@datadog/browser-core'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from '../domain/configuration'

function buildEndpointHost(site: string): string {
  // Use 'dd.' prefix only for staging, 'app.' for production
  if (site === 'datad0g.com') {
    return `dd.${site}`
  }
  return `app.${site}`
}

export function createFlagsConfigurationFetcher(initConfiguration: FlaggingInitConfiguration) {
  let host: string

  if (initConfiguration.flaggingProxy) {
    // Use flaggingProxy if provided
    host = initConfiguration.flaggingProxy
  } else {
    // Use site parameter or default
    host = initConfiguration.site || 'datad0g.com'
  }

  const url = new URL(`https://${host}/api/unstable/precompute-assignments`)

  const defaultHeaders = {
    'Content-Type': 'application/vnd.api+json',
    ...(initConfiguration.overwriteRequestHeaders
      ? {}
      : {
          'dd-client-token': initConfiguration.clientToken,
          'dd-application-id': initConfiguration.applicationId,
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
