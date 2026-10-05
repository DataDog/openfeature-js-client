const assert = require('node:assert/strict')
const { test } = require('node:test')
const { configurationFromString } = require('@datadog/openfeature-node-server/rules-based')
const fixture = require('../packages/browser/test/data/rules-v1-wire.json')
const providerConfiguration = require('../packages/core/test/ffe-system-test-data/ufc-config.json')
const logger = { debug() {}, info() {}, warn() {}, error() {} }

for (const name of ['provider', 'provider-with-ssr']) {
  test(`${name} bundle initializes the provider and evaluates without OpenFeature`, async () => {
    const { createProvider } = require(`./dist/bundles/${name}/index.cjs`)
    const provider = createProvider(providerConfiguration)
    assert.equal(provider.getConfiguration(), providerConfiguration)
    await provider.initialize()
    for (const country of ['US', 'France', 'US']) {
      const details = await provider.resolveBooleanEvaluation(
        'kill-switch',
        false,
        { targetingKey: 'test-user', country },
        logger
      )
      assert.equal(details.value, country === 'US')
      assert.equal(details.variant, country === 'US' ? 'on' : 'off')
      assert.equal(details.errorCode, undefined)
    }
    const details = await provider.resolveBooleanEvaluation('missing', false, { targetingKey: 'test-user' }, logger)
    assert.equal(details.value, false)
    assert.equal(details.errorCode, 'FLAG_NOT_FOUND')
  })
}

for (const name of ['ssr', 'provider-with-ssr']) {
  test(`${name} bundle fetches client rules and returns portable configuration`, async () => {
    const { fetchBrowserConfiguration } = require(`./dist/bundles/${name}/index.cjs`)
    let calls = 0
    const wire = await fetchBrowserConfiguration({
      clientToken: 'test-token',
      env: 'test',
      fetch: async (url, request) => {
        calls++
        assert.equal(new URL(url).pathname, '/api/v2/feature-flagging/config/rules-based/client')
        assert.equal(request.headers['dd-client-token'], 'test-token')
        return new Response(Buffer.from(fixture.rules.response, 'base64'), {
          headers: { 'Content-Type': 'application/protobuf', ETag: fixture.rules.etag },
        })
      },
    })
    const configuration = configurationFromString(wire)
    assert.equal(configuration.rules.etag, fixture.rules.etag)
    assert.deepEqual(configuration.rules.response, configurationFromString(JSON.stringify(fixture)).rules.response)
    assert.equal(calls, 1)
  })
}
