# Datadog OpenFeature Node.js Server Client

This package provides OpenFeature integration for Node.js server environments and is designed exclusively for internal Datadog use. Support is not provided for external organizations or third-party usage.

## Standalone Configuration Helpers

Requires Node.js 18 or newer. Fetch and parse rules without initializing a tracer or provider. The customer-facing `dd-trace/openfeature` entrypoint is a separate follow-up; these examples use the internal package.

```javascript
import { fetchRulesConfiguration, configurationToString } from '@datadog/openfeature-node-server/rules-based'

// Server distribution is the default. Rules do not depend on an evaluation context.
const configuration = await fetchRulesConfiguration({ apiKey, env: 'production' })

// For browser bootstrap data, explicitly fetch client-distributed rules.
const clientConfiguration = await fetchRulesConfiguration({
  distribution: 'client',
  clientToken,
  env: 'production',
})
const wire = configurationToString(clientConfiguration)
// Pass wire through the framework's safe SSR data serializer, not raw inline HTML.
```

**Only forward client-distributed configuration to the browser.** Serialization does not remove server-only flags. The client endpoint's access controls and opt-in requirements still apply.

Initialize the browser provider from the serialized configuration:

```javascript
import { configurationFromString, DatadogCoreProvider } from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'

const provider = new DatadogCoreProvider()
provider.setConfiguration(configurationFromString(wire))
await OpenFeature.setProviderAndWait(provider, context)
```

The returned `FlagsConfiguration` is **not** the legacy UFC JSON accepted by `DatadogNodeServerProvider.setConfiguration()`. The existing Node provider is unchanged, and importing it from the root entrypoint does not load the protobuf decoder.

### Fetch Options and Errors

- `site` defaults to `datadoghq.com`.
- `fetch` overrides global Fetch. Custom transports must honor `signal` and `redirect: 'manual'`; redirects are rejected to protect credentials.
- `timeoutMs` defaults to `5000` and covers the request and response-body read. `signal` supports caller cancellation and earlier deadlines.
- Failures throw `ConfigurationFetchError` with a `code` and, for HTTP errors, `status`. Timeouts use `timeout`; other caller cancellations use `cancelled`.

Applications own retries, polling, storage, tracking, and fallback.

## End-user license agreement

https://www.datadoghq.com/legal/eula
