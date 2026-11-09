import { configurationToString, fetchPrecomputedConfiguration } from '@datadog/openfeature-node-server'

export async function fetchBrowserPrecomputed(options) {
  return configurationToString(await fetchPrecomputedConfiguration(options))
}
