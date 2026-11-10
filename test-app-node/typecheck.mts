import { DatadogNodeServerProvider, DependencyTelemetrySidecar } from '@datadog/openfeature-node-server'
import {
  configurationToString,
  DatadogCoreProvider,
  type DatadogCoreProviderOptions,
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

export async function loadProvider(fetchOptions: RulesConfigurationFetchOptions, options?: DatadogCoreProviderOptions) {
  return new DatadogCoreProvider(await fetchRulesConfiguration(fetchOptions), {
    dependencyTelemetrySidecar: new DependencyTelemetrySidecar(),
    ...options,
  })
}

// @ts-expect-error: Configuration helpers are only exported from the rules-based entrypoint.
import { fetchRulesConfiguration as rootFetch } from '@datadog/openfeature-node-server'

void [DatadogNodeServerProvider, rootFetch]
