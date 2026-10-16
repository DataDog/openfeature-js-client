import { DatadogNodeServerProvider } from '@datadog/openfeature-node-server'
import {
  configurationToString,
  fetchRulesConfiguration,
  type RulesConfigurationFetchOptions,
} from '@datadog/openfeature-node-server/rules-based'

export async function loadConfiguration(options: RulesConfigurationFetchOptions): Promise<string> {
  return configurationToString(await fetchRulesConfiguration(options))
}

// @ts-expect-error: Configuration helpers are only exported from the rules-based entrypoint.
import { fetchRulesConfiguration as rootFetch } from '@datadog/openfeature-node-server'

void [DatadogNodeServerProvider, rootFetch]
