const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const ts = require('typescript')
const configurations = require('../../test-app-react-native/configurations')

const appRoot = path.resolve(__dirname, '../../test-app-react-native/manual')
const runnerSource = ts.transpileModule(fs.readFileSync(path.join(appRoot, 'checks.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function runner(overrides = {}, importError = false, parserOverrides = {}) {
  const core = {
    configurationFromString: (wire) => ({ precomputed: JSON.parse(wire).precomputed }),
    evaluateRulesBasedConfiguration: (_config, type) => ({
      value: type === 'boolean' ? true : 42,
      variant: 'on',
      reason: 'STATIC',
    }),
    evaluate: (config, _type, _flag, _default, context) =>
      config.rules || context.targetingKey
        ? { value: true, reason: 'STATIC' }
        : { value: false, errorCode: 'INVALID_CONTEXT' },
    ...overrides,
  }
  const exports = {}
  vm.runInNewContext(runnerSource, {
    exports,
    performance,
    require(specifier) {
      if (importError) throw new Error('SDK initialization exploded')
      if (specifier === '@datadog/flagging-core') return core
      if (specifier === '@datadog/flagging-core/rules-based') {
        return { configurationFromString: JSON.parse, configurationToString: JSON.stringify, ...parserOverrides }
      }
      if (specifier === './configurations') return configurations
      throw new Error(`Unexpected import: ${specifier}`)
    },
  })
  return exports.runChecks
}

test('manual app reports every expected check and can run again', () => {
  const run = runner()
  for (const platform of ['ios', 'android']) {
    const report = run({ hermes: true, platform })
    assert.equal(report.results.length, 10)
    assert.ok(report.results.every((result) => result.passed))
    assert.ok(report.elapsedMs >= 0)
  }
})

test('manual app diagnostics do not JSON-stringify decoded protobuf BigInt values', () => {
  const run = runner({}, false, {
    configurationFromString(wire) {
      const decoded = JSON.parse(wire)
      if (decoded.rules) decoded.rules.response = { integer: 42n }
      return decoded
    },
    configurationToString: (value) =>
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item)),
  })
  const report = run({ hermes: true, platform: 'ios' })
  assert.equal(report.results.length, 10)
  assert.ok(report.results.every((result) => result.passed))
})

test('manual app cannot report all-pass on a non-Hermes or non-native runtime', () => {
  for (const runtime of [
    { hermes: false, platform: 'ios' },
    { hermes: true, platform: 'web' },
  ]) {
    const report = runner()(runtime)
    assert.equal(report.results[0].passed, false)
    assert.ok(report.results.slice(1).every((result) => result.passed))
  }
})

test('manual app shows SDK initialization failures rather than a false success', () => {
  const report = runner({}, true)({ hermes: true, platform: 'ios' })
  assert.equal(report.results.length, 2)
  assert.equal(report.results[1].passed, false)
  assert.match(report.results[1].detail, /SDK initialization exploded/)
})

test('manual app rejects incorrect evaluation results and continues remaining checks', () => {
  const report = runner({ evaluateRulesBasedConfiguration: () => ({ value: false, reason: 'ERROR' }) })({
    hermes: true,
    platform: 'ios',
  })
  const failed = report.results.filter((result) => !result.passed).map((result) => result.name)
  assert.equal(failed.join(', '), 'Boolean rule, Integer rule, 1,000 repeated evaluations')
  assert.equal(report.results.length, 10)
})

function metroConfig(mode, upstream = false) {
  let delegated = 0
  const base = { resolver: { resolverMainFields: ['react-native', 'browser', 'main'] } }
  if (upstream) {
    base.resolver.resolveRequest = () => {
      delegated++
      return { type: 'sourceFile', filePath: '/packed/core.js' }
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'metro.config.js'), 'utf8'), {
    module,
    __dirname: appRoot,
    process: { env: { EXPO_PUBLIC_CORE_RESOLUTION: mode } },
    console: { log() {} },
    require(specifier) {
      assert.equal(specifier, 'expo/metro-config')
      return { getDefaultConfig: () => base }
    },
  })
  return { config: module.exports, delegated: () => delegated }
}

test('manual Metro modes use real modern, legacy CJS, and legacy ESM resolution', () => {
  const defaults = metroConfig().config.resolver
  assert.equal(defaults.unstable_enablePackageExports, false)
  assert.equal(defaults.resolverMainFields.join(','), 'react-native,browser,main')
  assert.equal(metroConfig('modern').config.resolver.unstable_enablePackageExports, true)
  const esm = metroConfig('legacy-esm').config.resolver
  assert.equal(esm.unstable_enablePackageExports, false)
  assert.equal(esm.resolverMainFields.join(','), 'react-native,browser,module,main')
  assert.throws(() => metroConfig('typo'), /Unknown CORE_RESOLUTION/)
})

test('manual Metro logging delegates without aliasing or bypassing the upstream resolver', () => {
  const { config, delegated } = metroConfig('legacy-cjs', true)
  const result = config.resolver.resolveRequest({}, '@datadog/flagging-core', 'ios')
  assert.equal(result.filePath, '/packed/core.js')
  assert.equal(delegated(), 1)
  const fallback = metroConfig('legacy-esm').config.resolver
  const expected = { type: 'sourceFile', filePath: '/packed/legacy-esm.js' }
  assert.equal(
    fallback.resolveRequest({ resolveRequest: () => expected }, '@datadog/flagging-core', 'android'),
    expected
  )
})
