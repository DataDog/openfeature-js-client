import { OpenFeature, type Provider } from '@openfeature/web-sdk'
import { reportSuccess } from './smoke'

export const providerOptions = {
  clientToken: 'test-token',
  site: 'datad0g.com',
  env: 'test',
}

export async function runProviderScenario(provider: Provider): Promise<void> {
  await OpenFeature.setProviderAndWait(provider, { targetingKey: 'browser-user-a' })
  const client = OpenFeature.getClient()
  const initial = client.getBooleanDetails('browser-flag', false)
  await OpenFeature.setContext({ targetingKey: 'browser-user-b' })
  const updated = client.getBooleanDetails('browser-flag', false)

  reportSuccess({
    provider: provider.metadata.name,
    initialValue: initial.value,
    initialReason: initial.reason,
    updatedValue: updated.value,
    updatedReason: updated.reason,
    targetingKey: OpenFeature.getContext().targetingKey,
  })
}
