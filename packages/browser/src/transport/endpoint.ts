// Explicit mapping of prod sites to their datacenter
const siteConfig: Record<string, { dc?: string; tld?: string }> = {
  'datadoghq.com': {},
  'us3.datadoghq.com': { dc: 'us3' },
  'us5.datadoghq.com': { dc: 'us5' },
  'ap1.datadoghq.com': { dc: 'ap1' },
  'ap2.datadoghq.com': { dc: 'ap2' },
  'datadoghq.eu': { tld: 'eu' },
}

export function buildEndpointHost(site?: string, customerDomain = 'preview'): string {
  if (site === 'ddog-gov.com') {
    throw new Error('ddog-gov.com is not supported for flagging endpoints')
  }

  if (site === 'datad0g.com') {
    return `${customerDomain}.ff-cdn.datad0g.com`
  }

  // If no site provided, default to datadoghq.com
  if (!site) {
    site = 'datadoghq.com'
  }

  // Throw error if site is not in the map
  if (!(site in siteConfig)) {
    throw new Error(`Unsupported site: ${site}. Supported sites: ${Object.keys(siteConfig).join(', ')}`)
  }

  const config = siteConfig[site]
  const dc = config.dc ?? ''
  const tld = config.tld ?? 'com'

  // customer domain is for future use
  // ff-cdn is the subdomain pointing to the CDN servers
  // dc is the datacenter, if specified
  // tld is the top level domain, changes for eu DCs
  return `${customerDomain}.ff-cdn.${dc ? dc + '.' : ''}datadoghq.${tld}`
}
