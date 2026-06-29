import type { EvaluationContext } from '@openfeature/web-sdk'
import { MultiProvider, OpenFeature } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from './domain/configuration'
import { DevToolsProvider } from './openfeature/devtools-provider'
import { DatadogProvider } from './openfeature/provider'

export interface InitFeatureFlagsOptions extends FlaggingInitConfiguration {
  enableDevTools?: boolean
  contexts?: Record<string, EvaluationContext>
}

export async function initFeatureFlags({
  enableDevTools = false,
  contexts = { user: {} },
  ...ddConfig
}: InitFeatureFlagsOptions): Promise<void> {
  const makeProvider = () => {
    const datadog = new DatadogProvider(ddConfig)
    if (!enableDevTools) return datadog
    return new MultiProvider([
      { provider: new DevToolsProvider(), name: 'devtools' },
      { provider: datadog, name: 'datadog' },
    ])
  }

  await Promise.all(
    Object.entries(contexts).map(([name, context]) =>
      OpenFeature.setProviderAndWait(name, makeProvider(), context)
    )
  )
}
