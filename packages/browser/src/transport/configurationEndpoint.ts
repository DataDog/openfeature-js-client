import { buildEndpointHost } from '@datadog/flagging-core'

export interface ConfigurationEndpointOptions {
  site?: string
  flaggingProxy?: string
  env?: string | null
}

export function buildConfigurationUrl(options: ConfigurationEndpointOptions, endpoint: 'precomputed' | 'rules'): URL {
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
