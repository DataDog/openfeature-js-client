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

## Offline configuration parsing

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

### Using DatadogOfflineProvider with portable configuration

`DatadogOfflineProvider` is an opt-in provider for applications that supply their own flags configuration, such as an SSR bootstrap or offline init payload. The application controls configuration delivery through `setConfiguration()`; changing the OpenFeature context does not fetch or poll configuration. By default it also sends no telemetry.

For static offline initialization, a context-specific precomputed configuration must use the OpenFeature context for which it was computed. Use `getPrecomputedContext()` to access a detached copy through the supported API. An empty context (`{}`) is treated literally and does not select the embedded context.

```javascript
import {
  configurationFromString,
  getPrecomputedContext,
  DatadogOfflineProvider,
} from '@datadog/openfeature-browser/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'

const configuration = configurationFromString('...flags configuration string...')
const provider = new DatadogOfflineProvider()
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

To send the same exposure, flag-evaluation, and RUM tracking events as `DatadogProvider`, compose the Datadog tracking hooks you need and register them with OpenFeature. This only enables telemetry transport—flag configuration remains fully offline. Import only the hook factories your application uses.

```javascript
import {
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  createDatadogTrackingHooks,
} from '@datadog/openfeature-browser/rules-based'

const trackingOptions = {
  clientToken: 'client-token',
  applicationId: 'application-id',
  site: 'datadoghq.com',
  service: 'storefront',
}

const tracking = createDatadogTrackingHooks(
  createDatadogExposureLoggingHook(trackingOptions),
  createDatadogEvaluationLoggingHook(trackingOptions),
  createDatadogRumTrackingHook()
)

await tracking.initialize()

const provider = new DatadogOfflineProvider()
provider.setConfiguration(configuration)

await OpenFeature.setProviderAndWait('datadog-offline', provider, context)
const client = OpenFeature.getClient('datadog-offline')
client.addHooks(...tracking.hooks)

// Later, when replacing the active flag configuration before another evaluation:
provider.setConfiguration(nextConfiguration)
await tracking.resetExposureCache()
```

`initialize()` initializes exposure deduplication when `createDatadogExposureLoggingHook()` is included. `resetExposureCache()` clears that deduplication state when the active offline configuration is replaced. If no exposure hook is included, both methods resolve successfully as no-ops.

To exclude one of these integrations, omit that hook factory from both the import list and `createDatadogTrackingHooks()` call.

## End-user license agreement

https://www.datadoghq.com/legal/eula
