/**
 * TypeScript consumer test for @datadog/openfeature-node-server.
 *
 * Verifies that the bundled index.d.ts type declarations compile correctly
 * from a consumer's perspective. This test must pass in BOTH scenarios:
 *
 * 1. WITHOUT @openfeature/server-sdk installed (SSI / dd-trace scenario):
 *    The bundled index.d.ts should be self-contained with no @openfeature/*
 *    references. A consumer who only has dd-trace (not the OF SDK) must be
 *    able to import and use the provider without TypeScript errors.
 *
 * 2. WITH @openfeature/server-sdk installed (normal consumer scenario):
 *    The provider should be compatible with the OpenFeature SDK's types.
 *
 * This catches issues that dts-bundle-generator might introduce:
 * - Dangling @openfeature/* type references in the bundled index.d.ts
 * - Missing or incompatible inlined types
 * - Broken re-exports from @datadog/flagging-core
 */

import diagnostics_channel from 'node:diagnostics_channel'
import {
  DatadogNodeServerProvider,
  type DatadogNodeServerProviderOptions,
  type UniversalFlagConfigurationV1,
} from '@datadog/openfeature-node-server'

// --- Test 1: DatadogNodeServerProvider can be instantiated with correct options ---
// Consumers get the channel from diagnostics_channel.channel() (returns Channel<unknown, unknown>)
// and must cast to the type expected by the provider options.
const exposureChannel = diagnostics_channel.channel(
  'dd-trace:openfeature:exposure'
) as DatadogNodeServerProviderOptions['exposureChannel']

const options: DatadogNodeServerProviderOptions = {
  exposureChannel,
  initializationTimeoutMs: 5000,
}

const provider = new DatadogNodeServerProvider(options)

// --- Test 2: Provider metadata is properly typed ---
const providerName: string = provider.metadata.name

// --- Test 3: Paradigm type is inlined correctly ---
const runsOn: 'server' | 'client' = provider.runsOn

// --- Test 4: Events emitter is accessible and typed ---
const events = provider.events

// --- Test 5: Hooks array is accessible ---
const hooks = provider.hooks

// --- Test 6: UniversalFlagConfigurationV1 type is usable and correctly shaped ---
const config: UniversalFlagConfigurationV1 = {
  createdAt: '2024-01-01T00:00:00Z',
  format: 'universal-flag-configuration',
  environment: {
    name: 'production',
  },
  flags: {},
}

// --- Test 7: setConfiguration accepts the correct type ---
provider.setConfiguration(config)

// --- Test 8: getConfiguration returns the correct type ---
const retrieved = provider.getConfiguration()
if (retrieved) {
  const createdAt: string = retrieved.createdAt
  const format: string = retrieved.format
  void [createdAt, format]
}

// --- Test 9: setError accepts unknown ---
provider.setError(new Error('test error'))

// --- Test 10: initialize returns a Promise<void> ---
const initPromise: Promise<void> = provider.initialize()

// Verify all bindings are used (no unused variable errors with strict mode)
void [providerName, runsOn, events, hooks, initPromise]
