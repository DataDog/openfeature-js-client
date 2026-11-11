const assert = require('node:assert/strict')
const { test } = require('node:test')
const { evaluate } = require('@datadog/flagging-core')
const { getClientFingerprint } = require('../packages/browser/cjs')
const { configurationFromString, configurationToString } = require('@datadog/openfeature-node-server/rules-based')
const fixture = require('../packages/browser/test/data/rules-v1-wire.json')
const providerConfiguration = require('../packages/core/test/ffe-system-test-data/ufc-config.json')
const logger = { debug() {}, info() {}, warn() {}, error() {} }

for (const name of ['precomputed-fetch', 'precomputed-fetch-rules-based']) {
  test(`${name} bundle fetches compatible precomputed assignments without protobuf`, async () => {
    const { fetchBrowserPrecomputed } = require(`./dist/bundles/${name}/index.cjs`)
    const context = { targetingKey: 'user-1', country: 'US' }
    let calls = 0
    const wire = await fetchBrowserPrecomputed({
      distributionChannel: 'client',
      clientToken: 'token',
      env: 'prod',
      context,
      clientFingerprint: getClientFingerprint(),
      fetch: async (url, request) => {
        calls++
        assert.equal(new URL(url).pathname, '/precompute-assignments')
        assert.equal(request.headers['X-DD-FEATURE-FLAGS-CAPABILITIES'], 'assignment-encoding-flag-key-256-v1')
        assert.equal(request.redirect, 'manual')
        const { precomputeConfiguration } = require('@datadog/openfeature-node-server/rules-based')
        const configuration = precomputeConfiguration(configurationFromString(JSON.stringify(fixture)), context, {
          clientFingerprint: getClientFingerprint(),
        })
        return new Response(JSON.stringify(configuration.precomputed.response), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    const restored = configurationFromString(wire)
    assert.equal(restored.precomputed.response.data.attributes.obfuscated, true)
    assert.equal(evaluate(restored, 'boolean', 'test-flag', false, context).value, true)
    assert.equal(calls, 1)
  })
}

for (const name of ['precompute', 'provider-with-precompute']) {
  test(`${name} bundle encodes keys for a compatible client`, () => {
    const { precomputeConfiguration } = require(`./dist/bundles/${name}/index.cjs`)
    const context = { targetingKey: 'user-1', country: 'US' }
    const configuration = configurationFromString(JSON.stringify(fixture))
    const result = precomputeConfiguration(configuration, context, {
      clientFingerprint: getClientFingerprint(),
    })
    assert.equal(result.precomputed.response.data.attributes.obfuscated, true)
    const restored = configurationFromString(configurationToString(result))
    assert.equal(evaluate(restored, 'boolean', 'test-flag', false, context).value, true)
  })

  test(`${name} bundle precomputes nonempty assignments without rules or a source ETag`, () => {
    const { precomputeConfiguration } = require(`./dist/bundles/${name}/index.cjs`)
    const context = { targetingKey: 'user-1', country: 'US' }
    const configuration = configurationFromString(JSON.stringify(fixture))
    const result = configurationFromString(configurationToString(precomputeConfiguration(configuration, context)))
    assert.deepEqual(Object.keys(result), ['precomputed'])
    assert.deepEqual(result.precomputed.context, context)
    assert.equal(result.precomputed.etag, undefined)
    assert.deepEqual(result.precomputed.response.data.attributes.flags['test-flag'], {
      allocationKey: 'allocation',
      variationKey: 'on',
      variationValue: true,
      variationType: 'boolean',
      doLog: true,
      reason: 'TARGETING_MATCH',
      serialId: 7,
    })
  })
}

for (const name of ['provider', 'provider-with-ssr', 'provider-with-precompute']) {
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
