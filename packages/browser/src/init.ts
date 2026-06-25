import { OpenFeature, MultiProvider } from '@openfeature/web-sdk'
import type { EvaluationContext } from '@openfeature/web-sdk'
import type { FlaggingInitConfiguration } from './domain/configuration'
import { DatadogProvider } from './openfeature/provider'
import { DevToolsProvider } from './openfeature/devtools-provider'

export interface InitFeatureFlagsOptions extends FlaggingInitConfiguration {
  enableDevTools?: boolean
  userContext?: EvaluationContext
  orgContext?: EvaluationContext
}

export async function initFeatureFlags({
  enableDevTools = false,
  userContext = {},
  orgContext = {},
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

  await Promise.all([
    OpenFeature.setProviderAndWait('user', makeProvider(), userContext),
    OpenFeature.setProviderAndWait('org', makeProvider(), orgContext),
  ])
}
