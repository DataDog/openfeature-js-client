/**
 * Test script for validating @datadog/openfeature-node-server installation scenarios.
 *
 * This tests three scenarios from the PR:
 * 1. Basic dd-trace init (most users) - should always work
 * 2. OpenFeature SDK usage - works only if user installed @openfeature/server-sdk
 * 3. Datadog OpenFeature provider - works only if user installed OF dependencies
 */

const diagnostics_channel = require('node:diagnostics_channel')

const results = []

function test(name, fn) {
  try {
    fn()
    results.push({ name, status: 'pass' })
    console.log(`PASS: ${name}`)
  } catch (e) {
    results.push({ name, status: 'fail', error: e.message })
    console.log(`FAIL: ${name}: ${e.message}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, status: 'pass' })
    console.log(`PASS: ${name}`)
  } catch (e) {
    results.push({ name, status: 'fail', error: e.message })
    console.log(`FAIL: ${name}: ${e.message}`)
  }
}

async function runTests() {
  console.log('=== Node.js OpenFeature Integration Tests ===\n')

  // Scenario 1: Basic dd-trace init (simulated - we don't actually have dd-trace here)
  // In the real scenario with dd-trace, this would be: require('dd-trace').init()
  // For this test, we just verify our packages can be required without OF deps
  console.log('--- Scenario 1: Package requires without OpenFeature SDK ---')

  test('Require @datadog/flagging-core', () => {
    require('@datadog/flagging-core')
  })

  // Scenario 2: Try to use OpenFeature SDK
  console.log('\n--- Scenario 2: OpenFeature SDK availability ---')

  test('Require @openfeature/server-sdk', () => {
    require('@openfeature/server-sdk')
  })

  test('Require @openfeature/core', () => {
    require('@openfeature/core')
  })

  // Scenario 3: Datadog OpenFeature provider
  console.log('\n--- Scenario 3: Datadog OpenFeature Provider ---')

  test('Require @datadog/openfeature-node-server', () => {
    require('@datadog/openfeature-node-server')
  })

  test('Create DatadogNodeServerProvider instance', () => {
    const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
    const exposureChannel = diagnostics_channel.channel('dd-trace:openfeature:exposure')
    new DatadogNodeServerProvider({ exposureChannel })
  })

  await testAsync('Register provider with OpenFeature', async () => {
    const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
    const { OpenFeature } = require('@openfeature/server-sdk')
    const exposureChannel = diagnostics_channel.channel('dd-trace:openfeature:exposure')
    const provider = new DatadogNodeServerProvider({ exposureChannel })
    // Set a dummy configuration so initialization completes immediately
    provider.setConfiguration({ createdAt: Date.now(), flags: {} })
    await OpenFeature.setProviderAndWait(provider)
  })

  await testAsync('Evaluate a flag', async () => {
    const { OpenFeature } = require('@openfeature/server-sdk')
    const client = OpenFeature.getClient()
    const details = await client.getBooleanDetails('test-flag', false)
    if (details.flagKey !== 'test-flag') {
      throw new Error(`Expected flagKey 'test-flag', got '${details.flagKey}'`)
    }
  })

  // Summary
  console.log('\n=== Summary ===')
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  console.log(`Passed: ${passed}/${results.length}`)
  console.log(`Failed: ${failed}/${results.length}`)
}

runTests()
  .catch((e) => {
    console.error('Test runner error:', e)
    process.exit(1)
  })
