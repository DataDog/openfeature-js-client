# Datadog OpenFeature Node.js Server Client

This package provides OpenFeature integration for Node.js server environments and is designed exclusively for internal Datadog use. Support is not provided for external organizations or third-party usage.

## Standalone Configuration Helpers

Requires Node.js 18 or newer. Fetch and parse rules without initializing a tracer or provider. The customer-facing `dd-trace/openfeature` entrypoint is a separate follow-up; these examples use the internal package.

```javascript
import { fetchRulesConfiguration, configurationToString } from '@datadog/openfeature-node-server/rules-based'

// The server distribution channel is the default. Rules do not depend on an evaluation context.
const configuration = await fetchRulesConfiguration({ apiKey, env: 'production' })

// For browser bootstrap data, explicitly fetch client-distributed rules.
const clientConfiguration = await fetchRulesConfiguration({
  distributionChannel: 'client',
  clientToken,
  env: 'production',
  flagSelection: { tags: ['team:checkout'], keyPatterns: ['checkout-*'] },
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

- `distributionChannel` selects the configuration channel to fetch, not where the helper runs. It defaults to `server`; use `client` when preparing configuration for browser or mobile SDKs.
- `flagSelection` optionally requests flags matching any of the `tags` or whole-key glob `keyPatterns`. Both distribution channels support selection; omitting it requests the full configuration.
- `site` defaults to `datadoghq.com`.
- `fetch` overrides global Fetch. Custom transports must honor `signal` and `redirect: 'manual'`; redirects are rejected to protect credentials.
- `logger` reports dropped or server-ignored selections through `error(message)`. It defaults to `console`; provide your application's logger to route these diagnostics elsewhere.
- `timeoutMs` defaults to `5000` and covers the request and response-body read. `signal` supports caller cancellation and earlier deadlines.
- Failures throw `ConfigurationFetchError` with a `code` and, for HTTP errors, `status`. Timeouts use `timeout`; other caller cancellations use `cancelled`.

Applications own retries, polling, storage, tracking, and fallback.

### Flag Selection

Selection reduces the configuration payload fetched from the backend, including configurations prepared for SSR. Values are trimmed, deduplicated, and sorted by UTF-8 bytes using the same canonicalizer as the browser SDK. Each list accepts up to 31 distinct nonempty values, and each value can be at most 200 UTF-8 bytes. The helper sends repeated `selected_flag_tags` and `selected_flag_key_patterns` query parameters with RFC 3986 percent-encoding.

Selection is best-effort, matching the browser SDK. Malformed or over-limit selections are not sent, and the full configuration is requested instead. This also applies to errors while reading or encoding selection values and to selections that would make the URL exceed 8192 bytes. The helper logs one error per fetch explaining the reason and limit, without including selection values or credentials. Empty selections request the full configuration without logging an error.

The backend may also ignore selection and return the full configuration. When a selection was sent and a successful response includes a nonempty `DD-Flag-Selection-Ignored` header, the helper logs one error containing the server's reason before parsing the response. These fallbacks do not reject the fetch. Exceptions thrown by a custom logger do not interrupt configuration loading. No provider, tracer, or telemetry pipeline is initialized for these diagnostics.

When the backend applies a selection, flags outside it are absent from the returned configuration. A browser provider initialized from that wire returns the caller's default value for those flags, with `FLAG_NOT_FOUND` in the evaluation details. Select every flag the page evaluates.

**Selection is not an access-control boundary.** The helper returns the configuration supplied by the backend without filtering it locally. Continue to use the client distribution channel for anything forwarded to a browser or mobile SDK.

## End-user license agreement

https://www.datadoghq.com/legal/eula
