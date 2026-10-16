import { DatadogCoreProvider, fetchRulesConfiguration } from '@datadog/openfeature-browser/rules-based'
import { providerOptions, runProviderScenario } from './providerScenario'
import { reportError } from './smoke'

async function run(): Promise<void> {
  const configuration = await fetchRulesConfiguration(providerOptions)
  const provider = new DatadogCoreProvider()
  provider.setConfiguration(configuration)
  await runProviderScenario(provider)
}

void run().catch(reportError)
