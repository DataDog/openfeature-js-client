const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { gzipSync } = require('node:zlib')
const {
  createWebpackConfigs,
  hasProtobufModules,
  measureBundles,
  renderMarkdown,
} = require('../report-node-entrypoint-bundle-sizes')

const protobufModule = { name: './node_modules/@bufbuild/protobuf/dist/esm/from-binary.js' }

test('finds Protobuf runtime and schema modules, including concatenated modules and Windows paths', () => {
  assert.equal(hasProtobufModules([protobufModule]), true)
  assert.equal(hasProtobufModules([{ name: 'entry + 2 modules', modules: [protobufModule] }]), true)
  assert.equal(
    hasProtobufModules([{ name: './node_modules/@datadog/flagging-core/esm/configuration/generated/ufc_pb.js' }]),
    true
  )
  assert.equal(hasProtobufModules([{ name: '.\\node_modules\\@bufbuild\\protobuf\\dist\\esm\\from-binary.js' }]), true)
  assert.equal(
    hasProtobufModules([
      { name: './node_modules/@datadog/flagging-core/esm/evaluation/evaluateProtobufConfiguration.js' },
    ]),
    false
  )
})

test('bundles independent Node ESM scenarios from installed packages without workspace fallbacks', () => {
  const testAppDirectory = path.resolve('/tmp/test-app-node')
  const configs = createWebpackConfigs(testAppDirectory)
  assert.deepEqual(
    configs.map(({ name }) => name),
    ['provider', 'ssr', 'provider-with-ssr']
  )
  for (const config of configs) {
    assert.equal(config.context, testAppDirectory)
    assert.equal(config.target, 'node18')
    assert.equal(config.mode, 'production')
    assert.deepEqual(config.resolve.modules, [path.join(testAppDirectory, 'node_modules')])
    assert.deepEqual(config.resolve.conditionNames, ['module', 'import', 'node', 'default'])
    assert.deepEqual(config.resolve.mainFields, ['module', 'main'])
    assert.equal(config.entry, `./bundles/${config.name}.mjs`)
    assert.deepEqual(config.optimization, { splitChunks: false, runtimeChunk: false })
    assert.equal(config.output.path, path.join(testAppDirectory, 'dist', 'bundles', config.name))
    assert.equal(config.output.library.type, 'commonjs2')
  }
})

function writeBundles(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'node-bundle-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const contents = ['provider with datadog.ffe.flagging.ufc.v1 type check', 'SSR helpers', 'provider + SSR helpers']
  const builds = []
  for (const [index, name] of ['provider', 'ssr', 'provider-with-ssr'].entries()) {
    mkdirSync(path.join(directory, name))
    writeFileSync(path.join(directory, name, 'index.cjs'), contents[index])
    builds.push({ name, modules: name === 'provider' ? [] : [protobufModule], assets: [{ name: 'index.cjs' }] })
  }
  return { directory, contents, builds }
}

test('reports actual raw/gzip sizes, same-build opt-in cost, and measurement limits', (t) => {
  const { directory, contents, builds } = writeBundles(t)
  const measurements = measureBundles(directory, builds)
  for (const [index, measurement] of measurements.entries()) {
    assert.equal(measurement.rawBytes, Buffer.byteLength(contents[index]))
    assert.equal(measurement.gzipBytes, gzipSync(contents[index]).length)
  }
  assert.deepEqual(
    measurements.map(({ hasProtobuf }) => hasProtobuf),
    [false, true, true]
  )
  const report = renderMarkdown(measurements)
  assert.match(report, /Node provider only \| .* \| no \|/)
  assert.match(report, /SSR helpers only .* \| yes \|/)
  assert.match(report, /Node provider \+ SSR helpers \| .* \| yes \|/)
  const delta = ((measurements[2].rawBytes - measurements[0].rawBytes) / 1024).toFixed(1)
  assert.ok(report.includes(`adds ${delta} KiB raw`))
  assert.match(report, /not just the decoder/)
  assert.match(report, /not npm install sizes/)
  assert.match(report, /not for configuring that provider/)
})

for (const name of ['provider', 'ssr', 'provider-with-ssr']) {
  test(`rejects unexpected Protobuf dependency state in ${name}`, (t) => {
    const { directory, builds } = writeBundles(t)
    builds.find((build) => build.name === name).modules = name === 'provider' ? [protobufModule] : []
    assert.throws(() => measureBundles(directory, builds), /Unexpected Protobuf modules/)
  })
}

test('fails when a required bundle is missing', (t) => {
  const { directory, builds } = writeBundles(t)
  rmSync(path.join(directory, 'ssr', 'index.cjs'))
  assert.throws(() => measureBundles(directory, builds), /ENOENT/)
})

test('fails when a bundle is empty', (t) => {
  const { directory, builds } = writeBundles(t)
  writeFileSync(path.join(directory, 'provider', 'index.cjs'), '')
  assert.throws(() => measureBundles(directory, builds), /Empty bundle: provider/)
})

test('fails instead of reporting an incomplete size when more JavaScript chunks are emitted', (t) => {
  const { directory, builds } = writeBundles(t)
  builds[0].assets.push({ name: 'extra.js' })
  assert.throws(() => measureBundles(directory, builds), /Expected one standalone JavaScript bundle: provider/)
})

test('fails when build statistics are missing', (t) => {
  const { directory } = writeBundles(t)
  assert.throws(() => measureBundles(directory, []), /Missing build statistics: provider/)
})
