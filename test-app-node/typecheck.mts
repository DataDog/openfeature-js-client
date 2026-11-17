import * as root from '@datadog/openfeature-node-server'
import {
  DatadogNodeServerProvider,
  DependencyTelemetrySidecar,
  fetchPrecomputedConfiguration,
  type PrecomputedConfigurationFetchOptions,
  type SDKDiagnostic as RootSDKDiagnostic,
  configurationToString as serializePrecomputed,
} from '@datadog/openfeature-node-server'
import {
  configurationToString,
  createExposureTracking,
  DatadogCoreProvider,
  type DatadogCoreProviderOptions,
  type FlagSelection,
  fetchRulesConfiguration,
  precomputeConfiguration,
  type RulesConfigurationFetchOptions,
  type SDKDiagnostic,
} from '@datadog/openfeature-node-server/rules-based'

export async function loadConfiguration(options: RulesConfigurationFetchOptions): Promise<string> {
  const flagSelection: FlagSelection = { keyPatterns: ['ffe-*'] } as const
  return configurationToString(
    precomputeConfiguration(await fetchRulesConfiguration({ ...options, flagSelection, logger: console }), {
      targetingKey: 'subject',
    })
  )
}

export async function loadPrecomputed(options: PrecomputedConfigurationFetchOptions): Promise<string> {
  return serializePrecomputed(await fetchPrecomputedConfiguration(options))
}

export async function loadProvider(fetchOptions: RulesConfigurationFetchOptions, options?: DatadogCoreProviderOptions) {
  return new DatadogCoreProvider(await fetchRulesConfiguration(fetchOptions), {
    dependencyTelemetrySidecar: new DependencyTelemetrySidecar(),
    ...options,
  })
}

export async function loadTrackedProvider(fetchOptions: RulesConfigurationFetchOptions) {
  const tracking = createExposureTracking({ collectDependencyEvaluations: true })
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

// @ts-expect-error: Rules fetching is only exported from the rules-based entrypoint.
import { fetchRulesConfiguration as rootFetch } from '@datadog/openfeature-node-server'

// @ts-expect-error: The tracer integration factory is only exported from the rules-based entrypoint.
void root.createExposureTracking

void [DatadogNodeServerProvider, rootFetch]

export function loadDiagnosticProvider(
  configuration: ConstructorParameters<typeof DatadogCoreProvider>[0],
  onDiagnostic: (observation: RootSDKDiagnostic) => void | Promise<void>
) {
  const callback: (observation: SDKDiagnostic) => void | Promise<void> = onDiagnostic
  const provider = new DatadogCoreProvider(configuration, { onDiagnostic: callback })
  const reporter: Pick<DatadogNodeServerProvider, 'reportConfigurationFetchStart' | 'reportConfigurationFetchResult'> =
    provider
  reporter.reportConfigurationFetchStart()
  reporter.reportConfigurationFetchResult(true)
  return provider
}
