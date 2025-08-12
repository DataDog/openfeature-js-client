# Datadog OpenFeature JavaScript Clients

This repository hosts Browser and React Native clients for Datadog's OpenFeature implementation.

**Note: This project is currently in development.**

## Installation

```bash
npm install @datadog/openfeature-browser@alpha
# or
npm install @datadog/openfeature-browser@0.1.0-alpha.9
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
  applicationId: 'app-id', // Your application ID

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

## Testing Flag Randomization

A test script is included to verify flag randomization behavior across multiple subjects:

```bash
node test-randomization.js <flagKey> <numberOfTests>
```

### Setup

1. Build the packages:
```bash
yarn build
```

2. Create a `.env` file in the project root with your Datadog credentials:
```env
DD_CLIENT_TOKEN=your_client_token
DD_APPLICATION_ID=your_application_id
DD_API_KEY=your_api_key
DD_APPLICATION_KEY=your_application_key
```

3. Run the script:
```bash
# Test a boolean flag with 1000 random subjects
yarn node test-randomization.js my-feature-flag 1000

# Test with fewer subjects for quick validation
yarn node test-randomization.js my-feature-flag 100
```

### Output

The script will:
- Generate random subject keys (UUIDs)
- Evaluate the flag for each subject with different targeting contexts
- Display distribution statistics and randomization quality analysis
- Show percentage breakdown of true/false values
- Indicate deviation from expected 50/50 split for boolean flags

Example output:
```
Testing flag randomization for "my-flag" with 1000 subjects...
============================================================

Results:
============================================================
Total successful tests: 1000
Total unique values: 2

Value               Count     Percentage
----------------------------------------
true                523       52.30%
false               477       47.70%

Summary:
--------------------
📊 Boolean split: 52.3% true, 47.7% false
📈 Deviation from 50/50 split: 2.30%
✅ Good randomization (< 5% deviation)
```
