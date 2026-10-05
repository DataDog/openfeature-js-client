import { configurationToString, fetchRulesConfiguration } from '@datadog/openfeature-node-server/rules-based'

export async function fetchBrowserConfiguration(options) {
  const configuration = await fetchRulesConfiguration({ ...options, distribution: 'client' })
  return configurationToString(configuration)
}
