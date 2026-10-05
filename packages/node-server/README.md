# Datadog OpenFeature Node.js Server Client

This package provides OpenFeature integration for Node.js server environments and is designed exclusively for internal Datadog use. Support is not provided for external organizations or third-party usage.

## Standalone Configuration Helpers

These exports implement the configuration building blocks for the Node SDK. The customer-facing `dd-trace/openfeature` entrypoint requires a separate dd-trace integration and release. The examples below use this internal package to document its contract.

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

The helpers also support named imports from native ESM. They work without tracer initialization or OpenFeature registration. A call fetches and decodes one protobuf response. It does not change a provider, start polling, save configuration, or emit tracking events. Applications own retries, scheduling, storage, and fallback.

The existing `DatadogNodeServerProvider` stays at the root entrypoint. Importing it does not load the protobuf decoder; the rules-based helpers are opt-in. This separation limits runtime loading, not installed dependency size. Node's native `import` and `require` use the same CommonJS implementation. Bundlers that support the `module` export condition use the ESM build for tree shaking.

The result is the existing parsed `FlagsConfiguration` used by the core evaluator and the browser's `DatadogCoreProvider`. It is **not** the legacy UFC JSON accepted by `DatadogNodeServerProvider.setConfiguration()`. This addition does not change the existing Node provider. `configurationFromRulesBinary`, `configurationFromString`, and `configurationToString` reuse the core codecs; no browser SDK is needed on the server.

In the browser, use the existing rules-based API:

```javascript
import { configurationFromString, DatadogCoreProvider } from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'

const provider = new DatadogCoreProvider()
provider.setConfiguration(configurationFromString(wire))
await OpenFeature.setProviderAndWait(provider, context)
```

**Do not expose server-distributed configuration to the browser.** Serialization does not remove server-only flags. Client distribution selects the client rules endpoint and its existing access controls and opt-in requirements. A client token alone does not select client distribution. Missing, mixed, or mismatched credentials are rejected before a request.

### Transport Contract

- Requires Node.js 18 or newer. Uses global Fetch unless `fetch` supplies a Fetch-compatible implementation.
- `site` defaults to `datadoghq.com`. Supported sites: `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, and `datad0g.com`.
- `timeoutMs` defaults to 2000 and covers both the request and body reads. `signal` permits caller cancellation. Synchronous protobuf decoding cannot be interrupted by a timer.
- `maxResponseBytes` defaults to 10 MiB and limits the decoded HTTP body, including compressed or chunked responses. Applications with larger configurations can raise it explicitly.
- Redirects are rejected to avoid forwarding credentials. A custom transport must honor `signal` and `redirect: 'manual'`. Configure proxy routing in that transport; it is responsible for any destination changes.
- Only HTTP 200 with a nonempty `application/protobuf` body is accepted. This API does not accept a previous configuration or issue conditional requests; HTTP 304 is an error. Retrieval time and ETag are retained for serialization, not used as an implicit cache.
- Malformed protobuf rejects the fetch. Invalid individual flags remain flag-scoped evaluation errors without disabling valid flags. Serialization retains unknown protobuf fields.
- `ConfigurationFetchError.code` distinguishes `invalid_options`, `http`, `invalid_response`, `response_too_large`, `decode`, `transport`, `timeout`, and `cancelled`. HTTP failures also include `status`. Errors exclude raw response bodies and transport diagnostics, which can contain credentials.

### Verification

Run `yarn workspace @datadog/openfeature-node-server test --runInBand` for request, decoding, timeout, cancellation, and size-limit tests. After building all packages, `yarn test:node-install` checks installed CommonJS/native ESM exports, Node-only consumer types with legacy and modern module resolution, and Node-to-browser offline bootstrap. Fresh-process checks verify that neither `require` nor native `import` loads protobuf through the root entrypoint. The bootstrap test runs the built browser provider under Node, not a browser UI or SSR framework. These tests use synthetic configuration and mocked requests, not live credentials or customer data.

## End-user license agreement

https://www.datadoghq.com/legal/eula
