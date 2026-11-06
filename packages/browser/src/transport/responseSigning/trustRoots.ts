import stagingRoot from './staging-root.json'

// Exact HTTPS origins only. Add aliases with their deployment ownership reviewed;
// never discover trust from a response or inherit it from an overridden site.
const STAGING_ORIGINS = new Set(['https://preview.ff-cdn.datad0g.com'])

export function bundledRootsForEndpoint(endpoint: URL): readonly string[] {
  if (endpoint.username || endpoint.password || !STAGING_ORIGINS.has(endpoint.origin)) return []
  return [stagingRoot.certificateDerBase64]
}
