import { configurationToString } from '@datadog/openfeature-node-server'
import { fetchPrecomputedConfiguration } from '@datadog/openfeature-node-server/rules-based'

// The rules-capable serializer intentionally retains the protobuf codec; this scenario measures fetch-only use.

export async function fetchBrowserPrecomputed(options) {
  return configurationToString(await fetchPrecomputedConfiguration(options))
}
