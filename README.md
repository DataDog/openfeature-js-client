# Datadog OpenFeature JavaScript Clients

This repository hosts Browser and React Native clients, as well as the
NodeJS flag evaluator, for Datadog's OpenFeature implementation.

## Documentation

Please see the full documentation site: [Getting Started with Feature Flags](https://docs.datadoghq.com/getting_started/feature_flags/)

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
  clientToken: 'your-datadog-client-token',
  enableExposureLogging: true,
  enableFlagEvaluationTracking: true,
  site: 'datadoghq.com',
})

// Set the provider
await OpenFeature.setProvider(provider)

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

  // Assignment requests use one second per attempt and one retry by default
  assignmentRequestTimeoutMs: 1000,
  assignmentRequestRetryCount: 1,
})
```

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

## Contributing

### Setup

This project uses [`@lavamoat/allow-scripts`](https://github.com/LavaMoat/LavaMoat/tree/main/packages/allow-scripts) to protect against supply-chain attacks by blocking all dependency lifecycle scripts by default. Only explicitly allowlisted packages can run postinstall scripts.

To install dependencies:

```bash
yarn setup
```

Do **not** use bare `yarn install` for local development — it will skip the postinstall scripts that some dependencies need (e.g. `nx`, `unrs-resolver`).

### Adding new packages

When you add a dependency that includes lifecycle scripts (preinstall/install/postinstall):

1. Inspect the dependency's install scripts to verify they are safe.
2. Run `yarn allow-scripts auto` to update the allowlist in `package.json`.
3. Review the generated `lavamoat.allowScripts` entries — set trusted packages to `true` and leave untrusted ones as `false`.
4. Run `yarn setup` to re-install with the updated allowlist.

## End-user license agreement

https://www.datadoghq.com/legal/eula
