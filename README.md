# Datadog OpenFeature JavaScript Clients

This repository hosts Browser and React Native clients for Datadog's OpenFeature implementation.

**Note: This project is currently in development; expect breaking API changes.**

## Installation

### For Customers (Recommended)

**We recommend pinning to an exact preview version for stability:**

```bash
npm install @datadog/openfeature-browser@0.1.0-preview.1
```

Or use the `preview` tag for the latest preview version (less stable):

```bash
npm install @datadog/openfeature-browser@preview
```

This will install the latest preview version (currently `0.1.0-preview.x`).

### For Internal Development

Use the `alpha` tag for internal builds (not guaranteed to be stable):

```bash
npm install @datadog/openfeature-browser@alpha
```

This will install the latest alpha version (currently `0.1.0-alpha.x`).

### Specific Version

You can also install a specific version:

```bash
npm install @datadog/openfeature-browser@0.1.0-preview.1
```

## Quick Start

The main entry point is `DatadogProvider`, which is a provider for the [OpenFeature Web SDK](https://openfeature.dev/docs/reference/technologies/client/web/).

```javascript
import { DatadogProvider } from '@datadog/openfeature-browser'
import { OpenFeature } from '@openfeature/web-sdk'

// Initialize the provider
const provider = new DatadogProvider({
  clientToken: 'your-datadog-client-token',
  applicationId: 'your-application-id',
  enableExposureLogging: true,
  site: 'datadoghq.com',
  service: 'my-service',
  version: '1.0.0',
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
  // Temporary for alpha releases
  applicationId: 'app-id', // Your application ID (optional - if provided, will be sent as dd-application-id header)

  // Optional Datadog configuration
  site: 'datadoghq.com', // Datadog site (datadoghq.com, datadoghq.eu, etc.)
  service: 'my-service', // Service name
  version: '1.0.0', // Application version
  env: 'production', // Environment

  // Enable exposure logging
  enableExposureLogging: true,
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
  user: { id: 'user-123', email: 'user@example.com' },
})

// Now evaluate flags with the context
const result = await client.getBooleanDetails('premium-feature', false)
console.log(result.value) // Flag value
console.log(result.reason) // Evaluation reason
```
