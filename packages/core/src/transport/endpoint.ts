const PRODUCTION_SITES = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
  'datadoghq.eu',
])

/** Builds a flagging CDN host after validating the Datadog site. Does not make a request. */
export function buildEndpointHost(site: string, customerDomain = 'preview'): string {
  if (site === 'ddog-gov.com') {
    throw new Error('ddog-gov.com is not supported for flagging endpoints')
  }

  if (site === 'datad0g.com') {
    return `${customerDomain}.ff-cdn.datad0g.com`
  }

  if (!PRODUCTION_SITES.has(site)) {
    throw new Error(`Unsupported site: ${site}. Supported sites: ${[...PRODUCTION_SITES].join(', ')}`)
  }

  return `${customerDomain}.ff-cdn.${site}`
}
