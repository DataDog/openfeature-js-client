const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')
const webpack = require('webpack')
const { getCoreEntrypoints, synchronizeCoreEntrypoints } = require('./coreEntrypoints')
const webpackConfigs = require('../build/core-legacy-webpack.config')

const targets = (name) => ({
  types: `./cjs/${name}.d.ts`,
  import: `./esm/${name}.js`,
  require: `./cjs/${name}.js`,
  default: `./esm/${name}.js`,
})
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function fixture(t, entries = { './foo': targets('foo') }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'core-entrypoints-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifest = {
    name: '@datadog/flagging-core',
    main: 'cjs/index.js',
    module: 'esm/index.js',
    types: 'cjs/index.d.ts',
    sideEffects: ['./esm/initialization.js'],
    exports: { '.': targets('index'), ...entries, './package.json': './package.json' },
  }
  writeJson(path.join(root, 'package.json'), manifest)
  for (const entry of getCoreEntrypoints(manifest)) {
    const source = path.join(root, 'src', `${entry.source}.ts`)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, `export const name = ${JSON.stringify(entry.name)}\n`)
  }
  return root
}

test('adding a source and export generates all packaging metadata, including nested subpaths', (t) => {
  const root = fixture(t, { './foo': targets('foo'), './tools/bar': targets('bar') })
  const before = readJson(path.join(root, 'package.json'))
  const entries = synchronizeCoreEntrypoints(root)
  const after = readJson(path.join(root, 'package.json'))
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['foo', 'tools/bar']
  )
  assert.deepEqual(after.exports, before.exports)
  for (const key of ['main', 'module', 'types']) assert.equal(after[key], before[key])
  assert.deepEqual(after.files, ['cjs/', 'esm/', 'bundle/', 'foo/', 'tools/', '*.d.ts'])
  assert.deepEqual(after.typesVersions, { '*': { foo: ['cjs/foo.d.ts'], 'tools/bar': ['cjs/bar.d.ts'] } })
  assert.ok(after.sideEffects.includes('./esm/initialization.js'))
  assert.ok(after.sideEffects.includes('./bundle/legacy/esm/tools/bar.js'))
  assert.deepEqual(readJson(path.join(root, 'tools/bar/package.json')), {
    _generatedBy: 'scripts/generate-core-entrypoints.js',
    main: '../../bundle/legacy/cjs/tools/bar.js',
    module: '../../bundle/legacy/esm/tools/bar.js',
    types: '../../cjs/bar.d.ts',
  })
  synchronizeCoreEntrypoints(root, { check: true })
  const content = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  synchronizeCoreEntrypoints(root)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), content)
})

test('check mode reports drift without writing and gives the normal build command', (t) => {
  const root = fixture(t)
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  assert.throws(
    () => synchronizeCoreEntrypoints(root, { check: true }),
    /Run yarn workspace @datadog\/flagging-core build/
  )
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before)
  assert.equal(fs.existsSync(path.join(root, 'foo/package.json')), false)
  synchronizeCoreEntrypoints(root)
  fs.writeFileSync(path.join(root, 'foo/package.json'), '{}')
  assert.throws(() => synchronizeCoreEntrypoints(root, { check: true }), /unowned/)
})

test('removing an export cleans only generated metadata and preserves user files', (t) => {
  const root = fixture(t)
  synchronizeCoreEntrypoints(root)
  fs.writeFileSync(path.join(root, 'foo/keep.txt'), 'keep')
  const manifest = readJson(path.join(root, 'package.json'))
  delete manifest.exports['./foo']
  writeJson(path.join(root, 'package.json'), manifest)
  assert.throws(() => synchronizeCoreEntrypoints(root, { check: true }), /out of date/)
  synchronizeCoreEntrypoints(root)
  assert.equal(fs.existsSync(path.join(root, 'foo/package.json')), false)
  assert.equal(fs.readFileSync(path.join(root, 'foo/keep.txt'), 'utf8'), 'keep')
  const result = readJson(path.join(root, 'package.json'))
  assert.deepEqual(result.typesVersions, { '*': {} })
  assert.deepEqual(result.sideEffects, ['./esm/initialization.js'])
  assert.equal(result.files.includes('foo/'), false)
  assert.deepEqual(webpackConfigs({ packageRoot: root }), [])
  synchronizeCoreEntrypoints(root, { check: true })
})

for (const subpath of ['./*', './../escape', './src', './bundle/foo', './foo/../bar']) {
  test(`rejects unsupported or unsafe export ${subpath}`, () => {
    assert.throws(
      () => getCoreEntrypoints({ exports: { '.': targets('index'), [subpath]: targets('foo') } }),
      /Unsupported/
    )
  })
}

test('rejects inconsistent targets and missing sources without partial writes', (t) => {
  const root = fixture(t)
  const manifest = readJson(path.join(root, 'package.json'))
  manifest.exports['./foo'].require = './cjs/different.js'
  assert.throws(() => getCoreEntrypoints(manifest), /same esm/)
  fs.unlinkSync(path.join(root, 'src/foo.ts'))
  const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  assert.throws(() => synchronizeCoreEntrypoints(root), /no source file/)
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before)
})

test('does not overwrite an existing unowned package or follow a dangling symlink', (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'foo'))
  writeJson(path.join(root, 'foo/package.json'), { name: 'user-package' })
  assert.throws(() => synchronizeCoreEntrypoints(root), /unowned/)
  fs.unlinkSync(path.join(root, 'foo/package.json'))
  fs.symlinkSync(path.join(root, 'not-generated.json'), path.join(root, 'foo/package.json'))
  assert.throws(() => synchronizeCoreEntrypoints(root), /symlink/)
  assert.equal(fs.existsSync(path.join(root, 'not-generated.json')), false)
})

for (const sideEffects of [false, true]) {
  test(`preserves the meaning of sideEffects: ${sideEffects}`, (t) => {
    const root = fixture(t)
    const manifest = readJson(path.join(root, 'package.json'))
    manifest.sideEffects = sideEffects
    writeJson(path.join(root, 'package.json'), manifest)
    synchronizeCoreEntrypoints(root)
    const actual = readJson(path.join(root, 'package.json')).sideEffects
    assert.deepEqual(actual, sideEffects ? true : ['./bundle/legacy/cjs/foo.js', './bundle/legacy/esm/foo.js'])
  })
}

test('a second export builds working CJS/ESM bundles without bundler registration', async (t) => {
  const root = fixture(t, { './foo': targets('foo'), './tools/bar': targets('bar') })
  const entries = synchronizeCoreEntrypoints(root)
  for (const entry of entries) {
    const file = path.resolve(root, entry.import)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.copyFileSync(path.join(root, 'src', `${entry.source}.ts`), file)
  }
  const configs = webpackConfigs({ packageRoot: root })
  assert.equal(configs.length, 4)
  await new Promise((resolve, reject) => {
    const compiler = webpack(configs)
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) return reject(error || closeError)
        if (stats.hasErrors()) return reject(new Error(stats.toString()))
        resolve()
      })
    })
  })
  for (const entry of entries) {
    const manifest = readJson(path.join(root, entry.name, 'package.json'))
    assert.equal(require(path.join(root, entry.name)).name, entry.name)
    const modulePath = path.resolve(root, entry.name, manifest.module)
    assert.equal((await import(pathToFileURL(modulePath).href)).name, entry.name)
  }
})
