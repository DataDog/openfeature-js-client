import { DatadogNodeServerProvider } from '@datadog/openfeature-node-server'
import {
  configurationToString,
  type FlagSelection,
  fetchRulesConfiguration,
  precomputeConfiguration,
  type RulesConfigurationFetchOptions,
} from '@datadog/openfeature-node-server/rules-based'

export async function loadConfiguration(options: RulesConfigurationFetchOptions): Promise<string> {
  const flagSelection: FlagSelection = { keyPatterns: ['ffe-*'] } as const
  return configurationToString(
    precomputeConfiguration(await fetchRulesConfiguration({ ...options, flagSelection, logger: console }), {
      targetingKey: 'subject',
    })
  )
}

// @ts-expect-error: Configuration helpers are only exported from the rules-based entrypoint.
import { fetchRulesConfiguration as rootFetch } from '@datadog/openfeature-node-server'

void [DatadogNodeServerProvider, rootFetch]
