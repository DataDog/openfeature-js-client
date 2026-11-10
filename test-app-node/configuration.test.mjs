import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  ConfigurationFetchError,
  ConfigurationPrecomputeError,
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  DatadogCoreProvider,
  fetchRulesConfiguration,
  precomputeConfiguration,
} from '@datadog/openfeature-node-server/rules-based'

const require = createRequire(import.meta.url)
const cjs = require('@datadog/openfeature-node-server/rules-based')
let OpenFeature
try {
  ;({ OpenFeature } = require('@openfeature/server-sdk'))
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}

for (const mode of ['require', 'import']) {
  test(`${mode}: root entrypoint does not load protobuf; rules-based entrypoint opts in`, () => {
    // A fresh process prevents the imports above from hiding eager protobuf loading.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import assert from 'node:assert/strict'
          import { createRequire } from 'node:module'
          const require = createRequire(import.meta.url)
          const load = ${mode === 'require' ? '(name) => require(name)' : '(name) => import(name)'}
          const root = await load('@datadog/openfeature-node-server')
          assert.equal(typeof root.DatadogNodeServerProvider, 'function')
          assert.equal('fetchRulesConfiguration' in root, false)
          assert.equal('configurationFromString' in root, false)
          assert.equal('precomputeConfiguration' in root, false)
          assert.equal('DatadogCoreProvider' in root, false)
          const protobufModules = () => Object.keys(require.cache).filter((file) =>
            /@bufbuild[/\\\\]protobuf|configuration[/\\\\](generated|protobuf-text-encoding|rules-wire|ufc-protobuf)/.test(file)
          )
          assert.deepEqual(protobufModules(), [])
          const helpers = await load('@datadog/openfeature-node-server/rules-based')
          assert.equal(typeof helpers.fetchRulesConfiguration, 'function')
          assert.equal(typeof helpers.configurationFromString, 'function')
          assert.equal(typeof helpers.DatadogCoreProvider, 'function')
          const emptyRules = helpers.configurationFromRulesBinary(new Uint8Array())
          const snapshot = helpers.precomputeConfiguration(emptyRules, { targetingKey: 'subject' })
          const restored = helpers.configurationFromString(helpers.configurationToString(snapshot))
          assert.deepEqual(Object.keys(restored), ['precomputed'])
          assert.deepEqual(restored.precomputed.response.data.attributes.flags, {})
          assert.deepEqual(restored.precomputed.context, { targetingKey: 'subject' })
          assert.ok(protobufModules().length > 0)
        `,
      ],
      { cwd: new URL('.', import.meta.url), stdio: 'pipe' }
    )
  })
}

test('native ESM and CommonJS expose identical standalone helpers without OpenFeature initialization', () => {
  assert.equal('DatadogNodeServerProvider' in cjs, false)
  for (const [name, value] of Object.entries({
    ConfigurationFetchError,
    configurationFromRulesBinary,
    configurationFromString,
    ConfigurationPrecomputeError,
    configurationToString,
    DatadogCoreProvider,
    fetchRulesConfiguration,
    precomputeConfiguration,
  })) {
    assert.equal(typeof value, 'function')
    assert.equal(value, cjs[name])
  }
  assert.equal(globalThis.window, undefined)
  assert.equal(globalThis.document, undefined)
})

test('packed core provider evaluates and replaces local rules without OpenFeature or configuration fetching', async () => {
  const rules = configurationFromRulesBinary(new Uint8Array())
  const provider = new DatadogCoreProvider(rules)
  assert.equal('initialize' in provider, false)
  assert.deepEqual(provider.hooks, [])
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const result = await provider.resolveBooleanEvaluation('missing', false, { targetingKey: 'subject' }, logger)
  assert.equal(result.errorCode, 'FLAG_NOT_FOUND')
  assert.equal(result.value, false)
  provider.setConfiguration(configurationFromString(configurationToString(rules)))
  assert.throws(() => provider.setConfiguration({}), TypeError)
  assert.ok(provider.getConfiguration().rules)
  await provider.onClose()
})

test(
  'installed OpenFeature supports synchronous core registration and optional exposures',
  { skip: !OpenFeature },
  async () => {
    const fixture = require('../packages/browser/test/data/rules-v1-wire.json')
    const rules = configurationFromString(JSON.stringify(fixture))
    const sink = channel('test:offline-core:exposures')
    const exposures = []
    const record = (event) => exposures.push(event)
    sink.subscribe(record)
    try {
      const provider = new DatadogCoreProvider(rules, { exposureChannel: sink })
      OpenFeature.setProvider('offline-core', provider)
      const client = OpenFeature.getClient('offline-core')
      assert.equal(client.providerStatus, 'READY')
      const context = { targetingKey: 'subject', country: 'US' }
      const results = await Promise.all([
        client.getBooleanDetails('test-flag', false, context),
        client.getBooleanDetails('test-flag', false, context),
      ])
      assert.deepEqual(
        results.map((result) => result.value),
        [true, true]
      )
      assert.deepEqual(results.map((result) => result.flagMetadata.__dd_exposure_cache_hit).sort(), [false, true])
      assert.equal(exposures.length, 1)
      const failed = await client.getBooleanDetails(
        'test-flag',
        false,
        { ...context, targetingKey: 'retry-subject' },
        {
          hooks: [
            {
              after() {
                throw new Error('application hook failed')
              },
            },
          ],
        }
      )
      assert.equal(failed.errorCode, 'GENERAL')
      assert.equal(exposures.length, 1)
      await client.getBooleanValue('test-flag', false, { ...context, targetingKey: 'retry-subject' })
      assert.equal(exposures.length, 2)
      const changed = []
      client.addHandler('PROVIDER_CONFIGURATION_CHANGED', () => changed.push(true))
      provider.setConfiguration(configurationFromRulesBinary(new Uint8Array()))
      assert.deepEqual(changed, [true])
      assert.equal((await client.getBooleanDetails('test-flag', false, context)).errorCode, 'FLAG_NOT_FOUND')
    } finally {
      sink.unsubscribe(record)
      await OpenFeature.clearProviders()
    }
  }
)
