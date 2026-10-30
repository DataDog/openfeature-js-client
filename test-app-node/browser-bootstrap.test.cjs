const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  configurationToString,
  fetchRulesConfiguration,
  precomputeConfiguration,
} = require('@datadog/openfeature-node-server/rules-based')
const { configurationFromString, DatadogCoreProvider } = require('../packages/browser/cjs/rules-based')
const fixture = require('../packages/browser/test/data/rules-v1-wire.json')

test('the browser consumes a Node precomputed snapshot without rules, requests or tracking hooks', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('Precomputation and browser initialization must not fetch')
  }
  try {
    const rules = configurationFromString(JSON.stringify(fixture))
    const context = { targetingKey: 'user-1', country: 'US' }
    const snapshot = configurationFromString(configurationToString(precomputeConfiguration(rules, context)))
    assert.equal(snapshot.rules, undefined)
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(snapshot)
    await provider.initialize(context)
    const logger = { debug() {}, info() {}, warn() {}, error() {} }
    const details = provider.resolveBooleanEvaluation('test-flag', false, context, logger)
    assert.equal(details.value, true)
    assert.equal(details.variant, 'on')
    assert.equal(details.reason, 'TARGETING_MATCH')
    assert.equal(calls, 0)
    assert.equal(
      provider.resolveBooleanEvaluation('test-flag', false, { ...context, country: 'CA' }, logger).errorCode,
      'INVALID_CONTEXT'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the unchanged browser provider initializes from Node wire and reevaluates without requests', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('Browser initialization must not fetch')
  }
  try {
    let calls = 0
    const configuration = await fetchRulesConfiguration({
      distributionChannel: 'client',
      clientToken: 'test-token',
      env: 'prod',
      fetch: async (url, request) => {
        calls++
        assert.equal(new URL(url).pathname, '/api/v2/feature-flagging/config/rules-based/client')
        assert.equal(request.headers['dd-client-token'], 'test-token')
        assert.equal(request.headers['dd-api-key'], undefined)
        assert.equal(request.redirect, 'manual')
        assert.doesNotMatch(request.headers['DD-Client-Library-Version'], /__BUILD_ENV__|independent/)
        return new Response(Buffer.from(fixture.rules.response, 'base64'), {
          headers: { 'Content-Type': 'application/protobuf', ETag: fixture.rules.etag },
        })
      },
    })
    const restored = configurationFromString(configurationToString(configuration))
    assert.equal(restored.rules.etag, fixture.rules.etag)
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(restored)
    let previous = { targetingKey: 'user-1', country: 'US' }
    await provider.initialize(previous)
    const logger = { debug() {}, info() {}, warn() {}, error() {} }
    for (const country of ['US', 'CA', 'US']) {
      const context = { targetingKey: 'user-1', country }
      await provider.onContextChange(previous, context)
      const details = provider.resolveBooleanEvaluation('test-flag', false, context, logger)
      assert.equal(details.value, true)
      assert.equal(details.variant, 'on')
      assert.equal(details.reason, country === 'US' ? 'TARGETING_MATCH' : 'SPLIT')
      previous = context
    }
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
