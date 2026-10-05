import { channel } from 'node:diagnostics_channel'
import { DatadogNodeServerProvider } from '@datadog/openfeature-node-server'

export function createProvider(configuration) {
  const provider = new DatadogNodeServerProvider({
    exposureChannel: channel('dd-trace:openfeature:bundle-smoke'),
  })
  provider.setConfiguration(configuration)
  return provider
}
