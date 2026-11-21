import stagingRoot from './staging-root.json'

/**
 * Response signing is available only on the Datadog staging site. The staging root in
 * `staging-root.json` is the only bundled trust anchor. There is no production root yet.
 */
export const SIGNING_SITE = 'datad0g.com'

/** The site value that `buildEndpointHost` resolves, with the same default. */
export function isSigningSite(site: string | undefined): boolean {
  return (site || 'datadoghq.com') === SIGNING_SITE
}

// Exact HTTPS origins only. Add aliases with their deployment ownership reviewed;
// never discover trust from a response or inherit it from an overridden site.
const STAGING_ORIGINS = new Set(['https://preview.ff-cdn.datad0g.com'])

export function bundledRootsForEndpoint(endpoint: URL): readonly string[] {
  if (endpoint.username || endpoint.password || !STAGING_ORIGINS.has(endpoint.origin)) return []
  return [stagingRoot.certificateDerBase64]
}
