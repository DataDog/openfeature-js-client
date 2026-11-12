import * as root from '@datadog/openfeature-node-server'
import { DatadogNodeServerProvider, DependencyTelemetrySidecar } from '@datadog/openfeature-node-server'
import {
  configurationToString,
  createExposureTracking,
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

export async function loadTrackedProvider(fetchOptions: RulesConfigurationFetchOptions) {
  const tracking = createExposureTracking()
  const options: DatadogCoreProviderOptions = tracking.providerOptions
  const provider = new DatadogCoreProvider(await fetchRulesConfiguration(fetchOptions), options)
  provider.hooks.push(
    tracking.createHook({
      hasSubscribers: true,
      publish: (event) => {
        const flagKey: string = event.flag.key
        void flagKey
      },
    })
  )
  tracking.clear()
  return provider
}

// @ts-expect-error: Configuration helpers are only exported from the rules-based entrypoint.
import { fetchRulesConfiguration as rootFetch } from '@datadog/openfeature-node-server'

// @ts-expect-error: The tracer integration factory is only exported from the rules-based entrypoint.
void root.createExposureTracking

void [DatadogNodeServerProvider, rootFetch]
