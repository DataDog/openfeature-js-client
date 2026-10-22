import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { DatadogNodeServerProvider } from '@datadog/openfeature-node-server'
import {
  ConfigurationFetchError,
  configurationFromRulesBinary,
  configurationFromString,
  configurationToString,
  fetchRulesConfiguration,
} from '@datadog/openfeature-node-server/rules-based'

const require = createRequire(import.meta.url)
const cjs = require('@datadog/openfeature-node-server/rules-based')

const fixtureRoot = new URL('../packages/core/test/ffe-system-test-data/', import.meta.url)
const configuration = JSON.parse(readFileSync(new URL('ufc-config.json', fixtureRoot), 'utf8'))
const doLogCases = JSON.parse(
  readFileSync(new URL('evaluation-cases/test-case-dolog-required.json', fixtureRoot), 'utf8')
)
const provider = new DatadogNodeServerProvider({ exposureChannel: channel('test:required-dolog') })
provider.setConfiguration(configuration)
const logger = { error() {}, warn() {}, info() {}, debug() {} }

for (const [index, testCase] of doLogCases.entries()) {
  test(`packed provider: required doLog case ${index} (${testCase.flag})`, async () => {
    const details = await provider.resolveStringEvaluation(
      testCase.flag,
      testCase.defaultValue,
      { targetingKey: testCase.targetingKey, ...testCase.attributes },
      logger
    )
    assert.equal(details.value, testCase.result.value)
    assert.equal(details.reason, testCase.result.reason)
    assert.equal(details.errorCode, testCase.result.errorCode)
  })
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
          const protobufModules = () => Object.keys(require.cache).filter((file) =>
            /@bufbuild[/\\\\]protobuf|configuration[/\\\\](generated|protobuf-text-encoding|rules-wire|ufc-protobuf)/.test(file)
          )
          assert.deepEqual(protobufModules(), [])
          const helpers = await load('@datadog/openfeature-node-server/rules-based')
          assert.equal(typeof helpers.fetchRulesConfiguration, 'function')
          assert.equal(typeof helpers.configurationFromString, 'function')
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
    configurationToString,
    fetchRulesConfiguration,
  })) {
    assert.equal(typeof value, 'function')
    assert.equal(value, cjs[name])
  }
  assert.equal(globalThis.window, undefined)
  assert.equal(globalThis.document, undefined)
})
