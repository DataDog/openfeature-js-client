# Datadog OpenFeature Node.js Server Client

This package provides OpenFeature integration for Node.js server environments and is designed exclusively for internal Datadog use. Support is not provided for external organizations or third-party usage.

## Offline Initialization and Local Evaluation

`DatadogCoreProvider` evaluates locally supplied rules or precomputed assignments without fetching, polling, or initializing a tracer or uploader. It is exported from `/rules-based`; the root entry point remains protobuf-free.

Use the [configuration helpers](#standalone-configuration-helpers) to fetch and serialize server-distributed rules as `flags.json`. With a valid local snapshot, registration is synchronous and immediately ready; OpenFeature evaluation methods return promises.

```javascript
import { readFileSync } from 'node:fs'
import { OpenFeature } from '@openfeature/server-sdk'
import {
  configurationFromString,
  DatadogCoreProvider,
  fetchRulesConfiguration,
} from '@datadog/openfeature-node-server/rules-based'

const configuration = configurationFromString(readFileSync('flags.json', 'utf8'))
const provider = new DatadogCoreProvider(configuration)
OpenFeature.setProvider(provider)
const client = OpenFeature.getClient()

const enabled = await client.getBooleanValue('checkout-enabled', false, { targetingKey: 'user-123' })
```

Refresh server-distributed rules without blocking evaluations against the active snapshot:

```javascript
const next = await fetchRulesConfiguration({ apiKey: process.env.DD_API_KEY, env: 'production' })
provider.setConfiguration(next)
```

The constructor and `setConfiguration()` validate and copy the configuration; `getConfiguration()` returns a detached copy. Failed fetches or invalid replacements leave the active configuration and provider status unchanged. Mixed configurations use their rules. Applications own refresh timing and ordering; snapshots do not expire automatically. Evaluation errors use the caller's default.

To use a [locally precomputed snapshot](#local-precomputation) instead:

```javascript
import { precomputeConfiguration } from '@datadog/openfeature-node-server/rules-based'

const context = { targetingKey: 'user-123' }
provider.setConfiguration(precomputeConfiguration(configuration, context))
```

Helper-generated snapshots require the same evaluation context; a mismatch returns the caller's default with `INVALID_CONTEXT`. Use rules for a shared provider serving multiple users, not per-user snapshot swaps. Keep server-distributed rules and their precomputed results on the server.

Tracking is off by default. Register OpenFeature hooks with `client.addHooks()`. Internal tracer integrations can supply `exposureChannel` and `dependencyTelemetrySidecar` and own telemetry opt-out, delivery, and writer cleanup.

## Standalone Configuration Helpers

Requires Node.js 18 or newer. Fetch and parse rules without initializing a tracer or provider.

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
  flagSelection: { keyPatterns: ['checkout-*'] },
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
- `flagSelection` supports only `keyPatterns` for local precomputation: source rules do not contain tag metadata. Patterns match the whole flag key, case-sensitively, with only `*` special; any matching pattern selects the flag. Patterns use the same Unicode whitespace trimming, deduplication, and limits as fetch selection (31 distinct nonempty patterns, 200 UTF-8 bytes each). Omitted selections and selections with no nonempty `keyPatterns` include all assignments; a `null` selection is also treated as absent at runtime. No matches produce an empty snapshot. Any defined `tags` value, including `[]` or `null`, malformed selections, and selections over a limit throw `invalid_options`, rather than falling back to all flags. Tags are also rejected by the TypeScript type.
- Selection limits the output assignments without modifying the source rules. Selected flags can evaluate unselected dependencies, but those dependency assignments are not included unless they also match. `onEvaluationError` reports failures of selected flags only, including failures caused by their dependencies. A shared rules snapshot can be reused with different selections; local selection cannot restore flags absent from that snapshot.
- Values (including scalar/null JSON), variants, reasons, allocation keys, serial IDs, exposure-logging intent, raw split features, environment, and configuration consent are retained. Source rules and their ETag are not forwarded; the rules ETag is not a validator for this context-specific output. Precomputation itself does not record an exposure.
- The helper's `experimentationOptOutMode` accepts `disabled` (default), `immediate`, or `future_experiments_only`. Enabled modes use the context's `dd_experimentation_opt_out_at` timestamp and preserve the effective policy in `evaluation_options`. When precomputing for Node's `DatadogCoreProvider`, use `disabled` or `immediate` and configure the provider with the same mode; snapshots acknowledging `future_experiments_only` return `INVALID_CONTEXT`.

**Precomputation is not an access-control boundary.** For client-directed SSR output, use client-distributed rules or an explicitly reviewed client-safe policy. Do not expose server-only flags or private context attributes merely because the rules were removed. Select a context that is safe to send to that client.

### Flag Selection

Selection reduces the configuration payload fetched from the backend, including configurations prepared for SSR. Values are trimmed, deduplicated, and sorted by UTF-8 bytes using the same canonicalizer as the browser SDK. Each list accepts up to 31 distinct nonempty values, and each value can be at most 200 UTF-8 bytes. The helper sends repeated `selected_flag_tags` and `selected_flag_key_patterns` query parameters with RFC 3986 percent-encoding.

Selection is best-effort, matching the browser SDK. Malformed or over-limit selections are not sent, and the full configuration is requested instead. This also applies to errors while reading or encoding selection values and to selections that would make the URL exceed 8192 bytes. The helper logs one error per fetch explaining the reason and limit, without including selection values or credentials. Empty selections request the full configuration without logging an error.

The backend may also ignore selection and return the full configuration. When a selection was sent and a successful response includes a nonempty `DD-Flag-Selection-Ignored` header, the helper logs one error containing the server's reason before parsing the response. These fallbacks do not reject the fetch. Exceptions thrown by a custom logger do not interrupt configuration loading. No provider, tracer, or telemetry pipeline is initialized for these diagnostics.

When the backend applies a selection, flags outside it are absent from the returned configuration. A browser provider initialized from that wire returns the caller's default value for those flags, with `FLAG_NOT_FOUND` in the evaluation details. Select every flag the page evaluates.

**Selection is not an access-control boundary.** The helper returns the configuration supplied by the backend without filtering it locally. Continue to use the client distribution channel for anything forwarded to a browser or mobile SDK.

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
