const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const fixtureRoot = path.resolve(__dirname, '../../test-app-react-native')
const packageRoot = path.join(fixtureRoot, 'node_modules/@datadog/flagging-core')
const configSource = fs.readFileSync(path.join(fixtureRoot, 'metro.config.js'), 'utf8')
const expectedPaths = {
  modern: ['cjs/index.js', 'bundle/legacy/cjs/rules-based.js'],
  'legacy-cjs': ['cjs/index.js', 'bundle/legacy/cjs/rules-based.js'],
  'legacy-esm': ['esm/index.js', 'bundle/legacy/esm/rules-based.js'],
}
const entrypoints = ['@datadog/flagging-core', '@datadog/flagging-core/rules-based']

function metroConfig(mode, upstreamResolve) {
  const module = { exports: {} }
  vm.runInNewContext(configSource, {
    module,
    __dirname: fixtureRoot,
    process: { env: { CORE_SMOKE_MODE: mode } },
    console: { log() {} },
    require(specifier) {
      if (specifier === 'node:assert/strict') return assert
      if (specifier === 'node:path') return path
      assert.equal(specifier, '@react-native/metro-config')
      return {
        getDefaultConfig: () => ({
          resolver: {
            resolverMainFields: ['react-native', 'browser', 'main'],
            resolveRequest: upstreamResolve,
          },
        }),
        mergeConfig: (base, overrides) => ({ resolver: { ...base.resolver, ...overrides.resolver } }),
      }
    },
  })
  return module.exports.resolver
}

test('smoke Metro modes configure exports and main fields without accepting unknown modes', () => {
  assert.equal(metroConfig().unstable_enablePackageExports, true)
  for (const mode of Object.keys(expectedPaths)) {
    const config = metroConfig(mode)
    assert.equal(config.unstable_enablePackageExports, mode === 'modern')
    assert.equal(
      config.resolverMainFields.join(','),
      mode === 'legacy-esm' ? 'react-native,browser,module,main' : 'react-native,browser,main'
    )
  }
  assert.throws(() => metroConfig('typo'), /Unknown CORE_SMOKE_MODE: typo/)
})

for (const [mode, paths] of Object.entries(expectedPaths)) {
  for (const platform of ['android', 'ios']) {
    test(`smoke Metro asserts actual entrypoint paths in ${mode}/${platform}`, () => {
      for (const upstream of [false, true]) {
        for (const [index, moduleName] of entrypoints.entries()) {
          const expected = { type: 'sourceFile', filePath: path.join(packageRoot, paths[index]) }
          let calls = 0
          const resolve = (actualContext, actualName, actualPlatform) => {
            assert.equal(actualContext, context)
            assert.equal(actualName, moduleName)
            assert.equal(actualPlatform, platform)
            calls++
            return expected
          }
          const context = {
            resolveRequest: upstream ? () => assert.fail('Must use the upstream resolver') : resolve,
          }
          const config = metroConfig(mode, upstream ? resolve : undefined)
          assert.equal(config.resolveRequest(context, moduleName, platform), expected)
          assert.equal(calls, 1)
        }
      }
    })

    test(`smoke Metro rejects unexpected entrypoint paths in ${mode}/${platform}`, () => {
      const config = metroConfig(mode)
      for (const moduleName of entrypoints) {
        for (const result of [
          { type: 'sourceFile', filePath: path.join(packageRoot, 'unexpected.js') },
          { type: 'sourceFile', filePath: path.join(packageRoot, 'cjs/rules-based-configuration-wire.js') },
          { type: 'sourceFile', filePath: path.join('/another-checkout', paths[entrypoints.indexOf(moduleName)]) },
          { type: 'empty' },
        ]) {
          assert.throws(() => config.resolveRequest({ resolveRequest: () => result }, moduleName, platform), {
            code: 'ERR_ASSERTION',
            message: new RegExp(`^Unexpected ${moduleName} resolution in ${mode}/${platform}`),
          })
        }
      }
    })
  }
}

test('smoke Metro leaves unrelated module resolutions unchanged', () => {
  const config = metroConfig()
  for (const result of [{ type: 'sourceFile', filePath: '/another/package/index.js' }, { type: 'empty' }]) {
    assert.equal(config.resolveRequest({ resolveRequest: () => result }, './configurations', 'ios'), result)
  }
})
