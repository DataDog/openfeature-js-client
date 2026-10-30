# Datadog OpenFeature Browser

## Installation

```bash
npm install @datadog/openfeature-browser
```

## Quick Start

The main entry point is `DatadogProvider`, which is a provider for the [OpenFeature Web SDK](https://openfeature.dev/docs/reference/technologies/client/web/).

```javascript
import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

// Initialize the provider
const provider = new DatadogProvider({
  applicationId: 'your-datadog-application-id',
  clientToken: 'your-datadog-client-token',
  trackExposures: true,
  enableFlagEvaluationTracking: true,
  site: 'datadoghq.com',
})

// Set the provider
await OpenFeature.setProviderAndWait(provider)

// Get a client and evaluate flags
const client = OpenFeature.getClient()
const flagValue = await client.getBooleanValue('my-flag', false)
```

## Configuration

```javascript
const provider = new DatadogProvider({
  // Required
  clientToken: 'pub_...', // Your Datadog client token
  site: 'datadoghq.com', // Datadog site (datadoghq.com, datadoghq.eu, etc.)
  env: 'production', // Environment

  // Optional Datadog configuration
  service: 'my-service', // Service name
  version: '1.0.0', // Application version
  applicationId: 'app-id', // Your application ID for RUM attribution

  // Enable exposure logging to Datadog (default: true)
  trackExposures: true,

  // Enable flag evaluation tracking
  enableFlagEvaluationTracking: true,

  // Optional Fetch-compatible implementation for flag configuration requests
  flagConfigurationFetch: globalThis.fetch,
})
```

The custom Fetch implementation applies only to flag configuration requests. Exposure and flag-evaluation intake
requests use their existing transports. It receives the provider-generated `RequestInit`, including Datadog
authentication and any configured custom headers, and may route or transform the request as needed.

### Request Timeouts and Retries for npm Consumers

The npm package provides Fetch-compatible wrappers for adding a timeout and retries. The CDN bundle does not expose
these helpers. The wrappers preserve the provider's cancellation signal and can be composed:

```javascript
import { DatadogProvider, withRetry, withTimeout } from '@datadog/openfeature-browser'

const customFetch = withRetry(withTimeout(globalThis.fetch, 5_000), 1)

const provider = new DatadogProvider({
  clientToken: 'pub_...',
  env: 'production',
  flagConfigurationFetch: customFetch,
})
```

Here, each attempt has a five-second timeout and `1` allows one retry after the initial request. The timeout includes
response-body download. The wrapper buffers the response body and is intended for flag configuration responses. A
timeout of `0` disables the timer. Valid timeout values end at `2_147_483_647`. Retry counts range from `0` to `10`.
`withRetry` uses randomized exponential backoff for Fetch `TypeError` failures, timeout failures, HTTP 408, and HTTP
5xx responses. On HTTP 503, a valid `Retry-After` value up to 30 seconds is treated as a minimum delay before jittered
backoff is added; responses that request a longer delay are not retried. It does not retry HTTP 429. Browsers report
network, CORS, and CSP failures as `TypeError`, so the wrapper cannot separate those causes. For timeout only, pass
`withTimeout(globalThis.fetch, 5_000)` directly as `flagConfigurationFetch`.

### Flag selection

Use `flagSelection` to load only the flags that match a set of tags or key patterns:

```javascript
const provider = new DatadogProvider({
  clientToken: 'pub_...',
  env: 'production',
  flagSelection: {
    tags: ['team:checkout'],
    keyPatterns: ['checkout-*'],
  },
})
```

Tags match exactly and are case-sensitive, and a flag matches if it has any of the tags. Key patterns are whole-key
globs where only `*` is special. A flag is selected if it matches any requested tag or any key pattern (either list).
Each list accepts at most 31 values after dedupe; each tag and key pattern is at most 200 UTF-8 bytes after trimming.
Leading and trailing Unicode whitespace is trimmed from every value, empty values are dropped, and duplicates are
removed. Selections over a limit are dropped and the full config is loaded. Very large selections may be ignored by the
server (`too_many_values`), in which case the full config loads. When the server applies the selection, flags outside
it are not loaded and evaluations return your default with `FLAG_NOT_FOUND`. Older servers or disabled selection gates
may return the full configuration without a warning. Caller-supplied `initialFlagsConfiguration` is not filtered
locally.

## Usage Examples

### Flag Evaluation

```javascript
const client = OpenFeature.getClient()

// Boolean flags
const showFeature = await client.getBooleanValue('show-new-feature', false)

// String flags
const theme = await client.getStringValue('app-theme', 'light')

// Number flags
const timeout = await client.getNumberValue('request-timeout', 5000)

// Object flags
const config = await client.getObjectValue('feature-config', {})
```

### Using Evaluation Context

Context must be set globally before flag evaluation and affects all subsequent evaluations:

```javascript
// Set global context (async operation)
await OpenFeature.setContext({
  targetingKey: 'user-123',
  userId: 'user-123',
  userEmail: 'user@example.com',
})

// Now evaluate flags with the context
const result = await client.getBooleanDetails('premium-feature', false)
console.log(result.value) // Flag value
console.log(result.reason) // Evaluation reason
```

### Exposures in your own data store

Use `ExposureHook` to receive every completed evaluation with the same deduplication decision the SDK uses when
sending exposures to Datadog, so you can record exposures in your own data store:

```javascript
import { ExposureHook } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

OpenFeature.addHooks(
  new ExposureHook((evaluation) => {
    if (!evaluation.shouldSend()) return
    yourWarehouse.record({
      flag: evaluation.flagKey,
      variant: evaluation.variant,
      allocation: evaluation.allocation,
      targetingKey: evaluation.targetingKey,
      features: evaluation.getFeatures(), // split features, e.g. holdout.key
    })
  })
)
```

- `isExposure()` is true when the evaluation succeeded and selected an allocation that logs exposures, repeats
  included.
- `isCacheHit()` is true when this subject was already exposed to the same flag, allocation, variant and serial ID.
- `shouldSend()` is true for a new or changed exposure: exactly what the SDK sends to Datadog.
- `getFeatures()` returns the read-only `HOOK` features of the selected split, such as `holdout.key` and
  `holdout.assignment_group`, when the flag is part of a holdout.

The callback runs on the evaluation thread; hand the data to a background queue instead of doing I/O in the callback.
An exception from the callback never affects the evaluation (the first failure logs a warning, later ones log at debug
level).

The SDK's exposure cache persists across page loads. A page reload that re-evaluates the same assignment is a cache
hit, so `shouldSend()` stays false and Datadog does not log the exposure again.

Set `trackExposures: false` to stop sending exposure events to Datadog only. The hook still receives every
evaluation, `shouldSend()` keeps its results, and the cache keeps recording. `enableExposureLogging` is deprecated
and superseded by `trackExposures`; when both are set, `trackExposures` wins.

Exposures require a Datadog provider registered directly with OpenFeature, or wrapped in `DatadogDevtools`.
Composed providers such as OpenFeature's `MultiProvider` are not supported: their child hooks finish before the
application's hooks can reject the result. Under a composed provider, the SDK sends no exposures to Datadog, does not
update the exposure cache and does not call `ExposureHook` callbacks, and logs one warning. Flag evaluation is not
affected.

#### Rules-based mode and `DatadogCoreProvider`

`DatadogProvider` wires this up automatically. In rules-based mode the application composes its own tracking
hooks, so it must share the exposure controller's cache with the provider for the verdicts to be stamped:

```javascript
import {
  composeDatadogTrackingHooks,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
} from '@datadog/openfeature-browser/rules-based'
import { ExposureHook } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

// One exposure controller owns the one exposure cache; pass it to the provider.
const exposureTracking = createDatadogExposureLoggingHook({
  clientToken: 'client-token',
  applicationId: 'application-id',
  site: 'datadoghq.com',
  trackExposures: false, // record-only: no exposures go to Datadog
})
const tracking = composeDatadogTrackingHooks(exposureTracking)
await tracking.initialize()

const provider = new DatadogCoreProvider({ exposureCache: tracking.exposureCache })
provider.setConfiguration(rulesConfiguration)

await OpenFeature.setProviderAndWait('datadog-core', provider, context)
const client = OpenFeature.getClient('datadog-core')
client.addHooks(...tracking.hooks)

OpenFeature.addHooks(
  new ExposureHook((evaluation) => {
    if (!evaluation.shouldSend()) return
    yourWarehouse.record({
      flag: evaluation.flagKey,
      variant: evaluation.variant,
      allocation: evaluation.allocation,
      targetingKey: evaluation.targetingKey,
      features: evaluation.getFeatures(),
    })
  })
)
```

The provider and the Datadog send path share that one cache, so `shouldSend()` and the SDK's own deduplication
always agree. `DatadogCoreProvider.initialize()` waits for the shared cache to load, so evaluations after
`setProviderAndWait` see persisted entries; still call `tracking.initialize()` before evaluating so the recording
hooks are active. Without the `exposureCache` option, evaluations carry no exposure verdict and the tracking
hooks behave exactly as before.

### Experimentation opt-out

Select an opt-out mode when you construct the provider. Your application owns and stores the subject's preference timestamp.

```typescript
import { DatadogProvider, ExperimentationOptOutMode } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

const provider = new DatadogProvider({
  clientToken: '<CLIENT_TOKEN>',
  env: 'production',
  experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
})

await OpenFeature.setProviderAndWait(provider, {
  targetingKey: user.id,
  ...(user.experimentationOptOutAt && {
    dd_experimentation_opt_out_at: user.experimentationOptOutAt,
  }),
})
const enabled = OpenFeature.getClient().getBooleanValue('new-route-planner', false)
```

| Mode                    | Behavior when the subject timestamp is present                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `Disabled` (default)    | Ignore the attribute.                                                                                     |
| `Immediate`             | Skip every allocation that logs experiment exposures.                                                     |
| `FutureExperimentsOnly` | Keep only exposure allocations activated strictly before the timestamp. Skip missing activation metadata. |

Use `ExperimentationOptOutMode.FutureExperimentsOnly` in the example to select the second policy.
Omit the attribute for eligible subjects. For opted-out subjects, supply a timestamp in the supported RFC3339 subset:
`YYYY-MM-DDTHH:mm:ss` with an optional decimal fraction, followed by `Z` or a numeric `+HH:mm` or `-HH:mm` offset.
Lowercase `t` and `z` are accepted. Fractional digits beyond nanoseconds are truncated without rounding.
For example, `2026-10-19T12:00:00Z`, `2026-10-19T12:00:00.123456789Z`, or `2026-10-19T08:00:00-04:00`.
Use valid calendar dates and seconds `00–59`. Both the written date and its UTC instant must have years `0000–9999`.
Whitespace, named timezones, Unicode signs, and leap seconds are rejected.
JSON `randomizationActivatedAt` values use the same format and are validated once when configuration is received. Producers should emit UTC with `Z`.
Invalid activation metadata returns `PARSE_ERROR` for the affected flag only when an opted-out subject uses `FutureExperimentsOnly`.
An invalid enabled timestamp returns the application default with `INVALID_CONTEXT` and does not send an assignment request.
In `Immediate` mode, any valid timestamp, including a future one, excludes the subject from exposure-logging allocations now.
In `FutureExperimentsOnly` mode, the SDK applies the cutoff now: it keeps exposure-logging allocations activated before the timestamp and skips those activated at or after it, or with missing activation metadata.
A future cutoff therefore keeps the subject eligible for experiments activated after now but before that cutoff. Comparisons retain nanosecond precision.
Future mode uses allocation activation, not prior enrollment. An older allocation can still assign a subject for the first time.
Holdouts use the same policy. Removing the attribute permits experimentation again.

Excluded subjects skip allocations that log experiment exposures. Evaluation continues through ordinary feature allocations in their existing order.
If none match, the application receives its default value. Skipped allocations do not log exposures.
This option does not suppress evaluation telemetry. Immediate withdrawal can change an enrolled subject's experience; account for this in experiment analysis.

`DatadogCoreProvider` accepts the same option. It applies exclusion locally for rules-based configurations.
For portable Precompute configurations, pass the same option to `fetchPrecomputedConfiguration` and the provider:

```typescript
const optOut = { experimentationOptOutMode: ExperimentationOptOutMode.Immediate }
const provider = new DatadogCoreProvider(optOut)
provider.setConfiguration(
  await fetchPrecomputedConfiguration({
    ...optOut,
    clientToken: '<CLIENT_TOKEN>',
    env: 'production',
    context,
  })
)
```

Precompute delivery requires backend support. Opted-out requests send `evaluation_options.experimentation_opt_out_mode`.
Immediate responses acknowledge `experimentation_opt_out=true`. Future responses acknowledge the named mode and exact timestamp instant.
The provider rejects unsupported responses and cached assignments from a different subject, mode, or opt-out timestamp.
With either enabled mode, `DatadogProvider` withholds assignments fetched for a different context, including for
subjects without an opt-out timestamp. Until usable assignments arrive, evaluations return the application default
with `PROVIDER_NOT_READY`, including after a failed refresh. A malformed opt-out timestamp returns `INVALID_CONTEXT`.
With `Disabled`, the previous assignments remain available during a context change.
For portable configurations, the application remains responsible for fetching replacement assignments when the context changes.

### Subject-level evaluation telemetry opt-out

Enable the control when creating the provider. Your application supplies its decision as a typed boolean in the evaluation context.

```typescript
import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

const provider = new DatadogProvider({
  clientToken: 'your-client-token',
  env: 'production',
  enableEvaluationTelemetryOptOutParameter: true,
})

await OpenFeature.setProviderAndWait(provider, {
  targetingKey: 'user-123',
  dd_evaluation_telemetry_opt_out: true,
})

const client = OpenFeature.getClient()
const enabled = client.getBooleanValue('new-feature', false)
```

Only boolean `true` suppresses new evaluation events, evaluation counts, and automatic RUM flag annotations. Missing, false, null, and other types preserve telemetry. Without explicit activation, the attribute does not suppress telemetry.

Use `OpenFeature.setContext()` to update the decision. Preserve the subject and its other attributes:

```typescript
await OpenFeature.setContext({
  ...OpenFeature.getContext(),
  dd_evaluation_telemetry_opt_out: false,
})
```

The attribute remains in the evaluation context, assignment requests, and exposure attributes. You can use it in targeting rules. Changing it follows the normal context refresh path and can produce another exposure under the existing deduplication rules.

The telemetry control does not override flag results, exclude subjects from experiments, or suppress exposures. Targeting rules that use this attribute can change assignments. Customer hooks and unrelated application telemetry remain unchanged. The control does not remove queued events or existing RUM annotations. It is not a general consent system. Exposures and assignment requests can still contain subject data.

For portable configuration, use `new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: true })`. The separately composed Datadog evaluation and RUM tracking hooks honor that provider's policy. Exposure hooks remain enabled. Rules evaluation receives the complete context. When fetching precomputed configuration separately, pass the same context, including this attribute, to `fetchPrecomputedConfiguration` and OpenFeature.

### RUM User Context

When RUM integration is enabled (the default), the provider includes flat primitive properties returned by
`DD_RUM.getUser()` in the OpenFeature evaluation context. The RUM user ID is used as the targeting key, while fields
set explicitly through `OpenFeature.setContext()` take precedence.

Initialize the RUM user before registering the provider:

```javascript
DD_RUM.setUser({
  id: 'user-123',
  email: 'user@example.com',
  company_name: 'Example, Inc.',
})

await OpenFeature.setProviderAndWait(new DatadogProvider(configuration))
```

If the RUM user changes after provider initialization, call
`await OpenFeature.setContext(OpenFeature.getContext())` to reconcile the provider with the latest user while
preserving explicitly configured OpenFeature properties. Nested RUM user properties are not included in the
evaluation context.

## Flag-key obfuscation

Requests to the Datadog Precompute endpoint automatically send
`X-DD-FEATURE-FLAGS-CAPABILITIES: assignment-encoding-flag-key-256-v1`.
This declares support for the `flag-key-sha256-v1` response encoding.
Datadog controls its server rollout.
Requests through `flaggingProxy` do not send this header by default. Proxy owners
can opt in through `customHeaders`. The proxy must forward the header and, for
cross-origin requests, allow it in its CORS response before enabling it.
The provider accepts both plaintext and obfuscated responses without an
application configuration change.

Continue evaluating the original flag key. The shared core hashes it with the
response's public salt before lookup. Flag values do not change. Evaluation
details, exposure events, and RUM annotations retain the original flag key. Portable
configuration and IndexedDB storage retain the descriptor with the assignments.
Unsupported or malformed encodings are rejected, not interpreted as plaintext.

Encoded portable snapshots use wire version 2, which older readers reject.
Plaintext and rules-only snapshots keep version 1. New readers accept both versions.
This version applies to SDK serialization, not the Precompute API response.

New IndexedDB writes use a separate cache key namespace for both response formats.
Older SDKs cannot read any entries in the new namespace, including plaintext.
New SDKs can read legacy plaintext
entries when the new namespace has no entry. A plaintext rollout rollback replaces
the encoded entry in the new namespace. It does not update an older SDK's cache.
A snapshot containing both encoded assignments and rules uses version 2.
Older readers reject that entire snapshot, including its rules.

Obfuscation removes readable flag-map keys. It is not encryption, authorization,
or response signing. Values, variation names, allocation names, telemetry,
and application code can still reveal a feature's purpose. Do not put sensitive
information in client-facing variant values, including JSON objects.

## Portable configuration parsing

The default entry point supports precomputed configurations without including
the Protobuf-ES dependency. Rules-based entries are ignored:

```javascript
import { configurationFromString, DatadogProvider, getPrecomputedContext } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

const configuration = configurationFromString(wire)
const context = getPrecomputedContext(configuration)

const provider = new DatadogProvider({
  applicationId: 'app-id',
  clientToken: 'pub_...',
  site: 'datadoghq.com',
  env: 'production',
  initialFlagsConfiguration: configuration,
})

if (context !== undefined) {
  await OpenFeature.setProviderAndWait(provider, context)
} else {
  await OpenFeature.setProviderAndWait(provider)
}
```

Rules-based configurations contain targeting rules that the SDK evaluates locally
against the OpenFeature evaluation context, rather than assignments precomputed for one context.
Applications that use them can opt into the full parser and its Protobuf-ES dependency
through the rules-based entry point:

```javascript
import {
  configurationFromString,
  DatadogProvider,
  getPrecomputedContext,
} from '@datadog/openfeature-browser/rules-based'
```

### Using DatadogCoreProvider with portable configuration

`DatadogCoreProvider` is a minimal evaluation-only provider for applications that supply their own flags configuration, such as an SSR bootstrap or local init payload. The application controls configuration delivery through `setConfiguration()`; changing the OpenFeature context does not fetch or poll configuration, and the provider does not install tracking hooks or send telemetry.

For static initialization, a context-specific precomputed configuration must use the OpenFeature context for which it was computed. Use `getPrecomputedContext()` to access a detached copy through the supported API. An empty context (`{}`) is treated literally and does not select the embedded context.

```javascript
import {
  configurationFromString,
  getPrecomputedContext,
  DatadogCoreProvider,
} from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'

const configuration = configurationFromString('...flags configuration string...')
const provider = new DatadogCoreProvider()
provider.setConfiguration(configuration)
const context = getPrecomputedContext(configuration)

if (context === undefined) {
  await OpenFeature.setProviderAndWait(provider)
} else {
  await OpenFeature.setProviderAndWait(provider, context)
}

const client = OpenFeature.getClient()
const enabled = client.getBooleanValue('new-checkout', false)
```

For dynamic context, use the `@datadog/openfeature-browser/rules-based` entry point and a rules-based configuration wire. After registering the provider, use `OpenFeature.setContext()` normally; context changes are evaluated locally without fetching configuration.

To send the same exposure, flag-evaluation, and RUM tracking events as `DatadogProvider`, compose the Datadog tracking hooks you need and register them with OpenFeature. This only enables telemetry transport—flag configuration remains application-managed. Import only the hook factories your application uses.

```javascript
import {
  DatadogCoreProvider,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  composeDatadogTrackingHooks,
} from '@datadog/openfeature-browser/rules-based'

const trackingOptions = {
  clientToken: 'client-token',
  applicationId: 'application-id',
  site: 'datadoghq.com',
  service: 'storefront',
}

const tracking = composeDatadogTrackingHooks(
  createDatadogExposureLoggingHook(trackingOptions),
  createDatadogEvaluationLoggingHook(trackingOptions),
  createDatadogRumTrackingHook()
)

await tracking.initialize()

const provider = new DatadogCoreProvider()
provider.setConfiguration(configuration)

await OpenFeature.setProviderAndWait('datadog-core', provider, context)
const client = OpenFeature.getClient('datadog-core')
client.addHooks(...tracking.hooks)

// Later, when replacing the active flag configuration before another evaluation:
provider.setConfiguration(nextConfiguration)

// When this client no longer needs tracking:
client.clearHooks()
await tracking.shutdown()
```

`composeDatadogTrackingHooks()` combines the supplied controllers' hooks and lifecycle methods. It does not initialize resources or register hooks with OpenFeature automatically. The composed result (and each exposure controller) exposes the one exposure cache as `exposureCache`; pass it to `DatadogCoreProvider`'s `exposureCache` option to stamp exposure deduplication verdicts in rules-based mode, as described in [Exposures in your own data store](#exposures-in-your-own-data-store).

The exposure controller accepts the same `trackExposures` option as `DatadogProvider` (default `true`; the deprecated
`enableExposureLogging` alias behaves identically). With `trackExposures: false` it runs record-only: nothing is
sent to Datadog, but the shared cache keeps recording so `ExposureHook` verdicts stay correct.

`tracking.initialize()` loads the exposure deduplication cache and starts the included hooks' transports, timers, and subscriptions. Exposure and evaluation hooks do not collect events until initialization completes; creating their controllers does not start those resources. Initialization is a no-op for hooks without a lifecycle, such as RUM tracking.

`tracking.shutdown()` flushes pending exposure/evaluation events and stops their timers and subscriptions. Requests already handed to the browser transport may still complete or retry. Both lifecycle methods are idempotent, and initialization after shutdown starts tracking again without clearing persisted exposure deduplication. Individual exposure and evaluation controllers also expose these methods. Lifecycle failures do not interrupt flag evaluation.

The application owns manually registered hooks: clearing client hooks or removing `DatadogCoreProvider` does not shut down their resources. Unregister them and call `tracking.shutdown()` when they are no longer needed. The regular `DatadogProvider` shuts down its own tracking resources through OpenFeature's provider lifecycle.

Precomputed assignments retain the existing exposure-reset behavior for plaintext and obfuscated responses.
On a refresh, `DatadogProvider` clears exposure deduplication when a previously loaded `createdAt` changes.
It does not clear on the first fetch without an initial configuration.
`DatadogCoreProvider` includes the configuration identity in exposure deduplication. Replacing the configuration,
including a changed `createdAt` or obfuscation salt, permits another exposure.
Reapplying the same configuration preserves deduplication. Neither provider emits an exposure until the application evaluates a flag.
`createdAt` is a configuration timestamp, not an experiment revision. This behavior does not depend on it changing on every request.

Exposure caches retain up to 50,000 entries per scope, matching the Node provider's limit.
Exposure checks use a bounded in-memory cache. Background IndexedDB transactions merge newly recorded exposures
with the stored entries, so instances sharing a scope preserve each other's writes without replaying their loaded snapshots.
Memory removes the least recently used entries; persistence removes the oldest written entries when it reaches its limit.
Evicted entries can produce another exposure.
Clearing a scope stores an empty cache with an incremented invalidation counter. Other instances reject pending or retried
writes with an older counter. On their next write, they discard stale memory and pending entries, then load the current cache.
This can produce repeat exposures. Other tabs' memory caches are not updated immediately, and concurrent tabs can still log
the same exposure. The cache reduces duplicates; it does not guarantee exactly-once logging across tabs.
If IndexedDB is unavailable or a storage operation fails, evaluation and in-memory deduplication continue.
An abrupt page exit can lose an unfinished write and permit a repeat exposure after reload.

For rules-based configurations, `DatadogCoreProvider` also includes the rules configuration identity. Changed rules allow new exposures without clearing application-managed hook state. Retrieval metadata (`fetchedAt` and `etag`) and the server's `createdAt` build timestamp do not change that identity. These fields remain available on the configuration and in its portable wire representation.

Both the standalone exposure hook and `DatadogProvider` scope persistent exposure caches by telemetry site, client token, proxy URL, environment, application, service, and source. Scope values are hashed into the storage namespace; raw tokens are not stored in cache keys. Recreating a hook with the same scope retains deduplication, while another destination can emit its own exposures. Existing localStorage and Chrome storage entries are not migrated or deleted, so upgrading can produce repeat exposures. Function-valued telemetry proxies use memory-only deduplication because their destination cannot be inferred reliably from the callback's identity.

To exclude one of these integrations, omit that hook factory from both the import list and `composeDatadogTrackingHooks()` call.

## SDK lifecycle telemetry

`DatadogProvider` sends SDK initialization and configuration-fetch error diagnostics through the same
`/api/v2/flagevaluation` JSONL transport as flag evaluations. No RUM initialization or flag evaluation is required.
Diagnostics are independent of the evaluation, exposure, and RUM tracking options.

An initialization report records `ready`, `failed`, `cached_fallback`, or `incomplete`, with elapsed timings.
Pending initialization produces an incomplete observation on page exit or provider close, at most once.
There is no initialization timeout observation. A resumed page can later report its settled result.
After initialization settles, at most one configuration-fetch error is reported per provider instance.
This bounds each instance to three diagnostic records. Transport batching can delay delivery, and page-exit delivery
is best effort. No diagnostic events does not establish whether the SDK is healthy.

Reports require `env` and either `applicationId` or `service`; `applicationId` takes precedence when both are provided.
They contain SDK name/version, application or service identity, environment, timings, and bounded error codes.
They do not contain flag values, evaluation context, targeting keys, client tokens, raw errors, or an instance identifier.
Reports are separate observations and must not be correlated to a specific instance from their timestamps alone.
Diagnostic queue failures do not change evaluation results.

The wire schema fixture in `test/data/sdkdiagnostic-v1.json` matches the flageval worker's diagnostic contract.
`yarn test:browser-install` tests the packaged SDK in Chromium, including mixed evaluation/diagnostic batches.
For manual staging checks, run `yarn dev` in `test-app` after that command and open `/diagnostics.html`.

## End-user license agreement

https://www.datadoghq.com/legal/eula
