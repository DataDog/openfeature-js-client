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
  enableExposureLogging: true,
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

  // Enable exposure logging
  enableExposureLogging: true,

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

`composeDatadogTrackingHooks()` combines the supplied controllers' hooks and lifecycle methods. It does not initialize resources or register hooks with OpenFeature automatically.

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
Exposure checks use a bounded in-memory cache. IndexedDB stores snapshots of that cache in the background.
The least recently used entries are removed when the cache reaches its limit. Evicted entries can produce another exposure.
If IndexedDB is unavailable or a storage operation fails, evaluation and in-memory deduplication continue.
An abrupt page exit can lose an unfinished write and permit a repeat exposure after reload.

For rules-based configurations, `DatadogCoreProvider` also includes the rules configuration identity. Changed rules allow new exposures without clearing application-managed hook state. Retrieval metadata (`fetchedAt` and `etag`) and the server's `createdAt` build timestamp do not change that identity. These fields remain available on the configuration and in its portable wire representation.

Both the standalone exposure hook and `DatadogProvider` scope persistent exposure caches by telemetry site, client token, proxy URL, environment, application, service, and source. Scope values are hashed into the storage namespace; raw tokens are not stored in cache keys. Recreating a hook with the same scope retains deduplication, while another destination can emit its own exposures. Existing localStorage and Chrome storage entries are not migrated or deleted, so upgrading can produce repeat exposures. Function-valued telemetry proxies use memory-only deduplication because their destination cannot be inferred reliably from the callback's identity.

To exclude one of these integrations, omit that hook factory from both the import list and `composeDatadogTrackingHooks()` call.

## End-user license agreement

https://www.datadoghq.com/legal/eula
