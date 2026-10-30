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
- `site` defaults to `datadoghq.com`.
- `fetch` overrides global Fetch. Custom transports must honor `signal` and `redirect: 'manual'`; redirects are rejected to protect credentials.
- `timeoutMs` defaults to `5000` and covers the request and response-body read. `signal` supports caller cancellation and earlier deadlines.
- Failures throw `ConfigurationFetchError` with a `code` and, for HTTP errors, `status`. Timeouts use `timeout`; other caller cancellations use `cancelled`.

Applications own retries, polling, storage, tracking, and fallback.

## Per-subject experimentation opt-out

Set the `experimentationOptOutMode` provider option to `ExperimentationOptOutMode.Immediate`.
The supported modes are `Disabled` (the default) and `Immediate`. `FutureExperimentsOnly` is not supported by this provider. Unsupported mode values throw during provider construction.
The provider uses the explicit option only. When using `dd-trace-js`, the tracer owns
`DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE` and passes the resolved mode to this provider.

```typescript
import { DatadogNodeServerProvider, ExperimentationOptOutMode } from '@datadog/openfeature-node-server'

const provider = new DatadogNodeServerProvider({
  exposureChannel,
  experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
})
// Supply the customer's stored preference with each evaluation.
const context = {
  targetingKey: athlete.id,
  ...(athlete.experimentationOptOutAt ? { dd_experimentation_opt_out_at: athlete.experimentationOptOutAt } : {}),
}
```

Use the shared timestamp subset: `YYYY-MM-DDTHH:mm:ss`, optionally followed by a decimal fraction, then `Z` or a numeric `±HH:mm` offset. Lowercase `t` and `z` are accepted. Fractions beyond nine digits are truncated without rounding. Calendar fields must be valid, seconds must be `00`–`59`, and both the written and normalized UTC year must be `0000`–`9999`. Whitespace, named time zones, compact offsets, Unicode signs, and leap seconds are rejected.

In immediate mode, any valid timestamp excludes the subject immediately, including a future timestamp.
The evaluator skips exposure-logging allocations before targeting and randomization, then tries ordinary allocations in order.
If none match, it returns the application's default value.
An invalid attribute returns `INVALID_CONTEXT` and the application default.
Disabled mode ignores the attribute.
Evaluation telemetry remains independent.
Immediate withdrawal can change an enrolled subject's experience; account for this in experiment analysis.

## End-user license agreement

https://www.datadoghq.com/legal/eula
