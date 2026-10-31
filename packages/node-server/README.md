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

### Local Precomputation

`precomputeConfiguration(configuration, context, options?)` evaluates parsed rules locally for one context and returns a precomputed-only `FlagsConfiguration`. It reuses the shared evaluator without initializing a provider or tracer, fetching, polling, or emitting tracking events. Parsing, fetching, and serialization remain separate building blocks.

```typescript
import {
  configurationToString,
  fetchRulesConfiguration,
  precomputeConfiguration,
} from '@datadog/openfeature-node-server/rules-based'

const rules = await fetchRulesConfiguration({
  distributionChannel: 'client',
  clientToken,
  env: 'production',
})
const context = { targetingKey: user.id, country: user.country }
const precomputed = precomputeConfiguration(rules, context, {
  onEvaluationError: ({ flagKey, errorCode }) => {
    console.warn('Flag omitted from precomputed configuration', { flagKey, errorCode })
  },
})
const wire = configurationToString(precomputed)
// Send wire through the framework's safe SSR serializer and use the same context in the browser.
```

You can also pass rules parsed with `configurationFromString()` or `configurationFromRulesBinary()`. The existing browser initialization example above accepts the resulting wire. A configuration containing both capabilities is evaluated using its rules, not its existing precomputed assignments.

- The helper captures one evaluation time and a detached JSON-compatible context. Recompute when rules or context change; a precomputed-only provider cannot reevaluate rules for a different subject. Dates, undefined values, nonfinite numbers, custom class instances, and cycles are not portable context values and are rejected.
- Only actual assignments are included. Flags with no matching assignment or an individual evaluation error are omitted, without inventing code defaults. The receiving JS provider returns the application's default with `FLAG_NOT_FOUND` for an omitted flag; the original error/reason is not preserved. This is Datadog's assignment-only format, not an OFREP bulk response.
- `onEvaluationError` receives the flag key and error code for each evaluation failure after the entire snapshot has been computed. It receives no context, values, or raw error messages; no-assignment outcomes do not invoke it. Exceptions thrown by the callback propagate.
- Missing or malformed rules, invalid contexts, and invalid options throw `ConfigurationPrecomputeError` with `invalid_configuration`, `invalid_context`, or `invalid_options`, respectively. A valid configuration with no flags produces an empty, context-bound snapshot.
- Values (including scalar/null JSON), variants, reasons, allocation keys, serial IDs, exposure-logging intent, raw split features, environment, and configuration consent are retained. Source rules and their ETag are not forwarded; the rules ETag is not a validator for this context-specific output. Precomputation itself does not record an exposure.
- The helper's `experimentationOptOutMode` accepts `disabled` (default), `immediate`, or `future_experiments_only`. Enabled modes use the context's `dd_experimentation_opt_out_at` timestamp and preserve the effective policy in `evaluation_options`. Configure a compatible receiving provider with the same policy. These helper options do not change the existing Node provider's supported modes.

**Precomputation is not an access-control boundary.** For client-directed SSR output, use client-distributed rules or an explicitly reviewed client-safe policy. Do not expose server-only flags or private context attributes merely because the rules were removed. Select a context that is safe to send to that client.

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
