const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { getAppDirectory, prepareExample } = require('../setup-react-native-example')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'react-native-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repoRoot = path.join(root, 'checkout')
  const cacheRoot = path.join(root, 'cache with spaces')
  const template = path.join(repoRoot, 'test-app-react-native/manual')
  fs.cpSync(path.resolve(__dirname, '../../test-app-react-native/manual'), template, { recursive: true })
  fs.copyFileSync(
    path.resolve(__dirname, '../../test-app-react-native/configurations.js'),
    path.join(template, '../configurations.js')
  )
  fs.mkdirSync(path.join(repoRoot, 'packages/core'), { recursive: true })
  const appDir = getAppDirectory(repoRoot, cacheRoot)
  const calls = []
  let builds = 0
  let failInstall = false
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    if (command === process.execPath) fs.writeFileSync(args.at(-1), `build ${++builds}`)
    if (command === 'git') return args[0] === 'rev-parse' ? 'abc123\n' : ' M local-source.ts\n'
    if (command === 'npm' && args[0] === 'install') {
      if (failInstall) throw new Error('install failed')
      const manifest = readJson(path.join(appDir, 'package.json'))
      manifest.dependencies['@datadog/flagging-core'] = `file:${args.at(-1)}`
      writeJson(path.join(appDir, 'package.json'), manifest)
    }
    return ''
  }
  return {
    root,
    repoRoot,
    cacheRoot,
    appDir,
    template,
    calls,
    prepare: () => prepareExample({ repoRoot, cacheRoot, run, log() {} }),
    failInstall: () => {
      failInstall = true
    },
  }
}

test('manual setup reuses one app per real checkout, including symlink aliases', (t) => {
  const f = fixture(t)
  const alias = path.join(f.root, 'alias')
  fs.symlinkSync(f.repoRoot, alias)
  assert.equal(getAppDirectory(alias, f.cacheRoot), f.appDir)
  const second = path.join(f.root, 'second-checkout')
  fs.mkdirSync(second)
  assert.notEqual(getAppDirectory(second, f.cacheRoot), f.appDir)
})

test('manual setup refreshes files and tarball while retaining dependency and Expo state', (t) => {
  const f = fixture(t)
  assert.equal(f.prepare(), f.appDir)
  const first = readJson(path.join(f.appDir, 'build-info.json'))
  fs.mkdirSync(path.join(f.appDir, 'node_modules'))
  fs.writeFileSync(path.join(f.appDir, 'node_modules/retained'), 'dependency cache')
  fs.mkdirSync(path.join(f.appDir, '.expo'))
  fs.writeFileSync(path.join(f.appDir, '.expo/retained'), 'Expo state')
  fs.writeFileSync(path.join(f.appDir, 'package-lock.json'), 'lockfile')
  fs.writeFileSync(path.join(f.appDir, 'unmanaged.tgz'), 'do not delete')
  fs.appendFileSync(path.join(f.template, 'App.tsx'), '\n// refreshed template\n')
  assert.equal(f.prepare(), f.appDir)
  const second = readJson(path.join(f.appDir, 'build-info.json'))
  assert.notEqual(second.tarball, first.tarball)
  assert.notEqual(second.sha256, first.sha256)
  assert.equal(fs.existsSync(path.join(f.appDir, first.tarball)), false)
  assert.equal(fs.readFileSync(path.join(f.appDir, second.tarball), 'utf8'), 'build 2')
  for (const file of ['node_modules/retained', '.expo/retained', 'package-lock.json', 'unmanaged.tgz']) {
    assert.ok(fs.existsSync(path.join(f.appDir, file)), file)
  }
  assert.match(fs.readFileSync(path.join(f.appDir, 'App.tsx'), 'utf8'), /refreshed template/)
  assert.equal(second.commit, 'abc123')
  assert.equal(second.dirty, true)
  const installs = f.calls.filter((call) => call.command === 'npm' && call.args[0] === 'install')
  assert.equal(installs.length, 2)
  assert.notEqual(installs[0].args.at(-1), installs[1].args.at(-1))
  assert.ok(installs.every((call) => call.args.includes('--ignore-scripts') && call.args.includes('--save-exact')))
  assert.equal(fs.existsSync(path.join(f.appDir, '.prepare.lock')), false)
})

test('manual setup refuses caches inside the checkout and unowned directories', (t) => {
  const f = fixture(t)
  assert.throws(() => prepareExample({ repoRoot: f.repoRoot, cacheRoot: f.repoRoot }), /outside the repository/)
  fs.mkdirSync(f.appDir, { recursive: true })
  fs.writeFileSync(path.join(f.appDir, 'unrelated'), 'keep')
  assert.throws(f.prepare, /unrecognized directory/)
  assert.equal(fs.readFileSync(path.join(f.appDir, 'unrelated'), 'utf8'), 'keep')
  writeJson(path.join(f.appDir, '.flagging-core-example.json'), { version: 1, repoRoot: '/another/checkout' })
  assert.throws(f.prepare, /another checkout/)
})

test('manual setup releases its lock on failure and keeps previous installed-build metadata', (t) => {
  const f = fixture(t)
  f.prepare()
  const before = readJson(path.join(f.appDir, 'build-info.json'))
  f.failInstall()
  assert.throws(f.prepare, /install failed/)
  assert.deepEqual(readJson(path.join(f.appDir, 'build-info.json')), before)
  assert.ok(fs.existsSync(path.join(f.appDir, before.tarball)))
  assert.equal(fs.existsSync(path.join(f.appDir, '.prepare.lock')), false)
})

test('manual setup refuses concurrent preparations without deleting the other lock', (t) => {
  const f = fixture(t)
  f.prepare()
  fs.writeFileSync(path.join(f.appDir, '.prepare.lock'), 'other process')
  assert.throws(f.prepare, /Preparation is already running/)
  assert.equal(fs.readFileSync(path.join(f.appDir, '.prepare.lock'), 'utf8'), 'other process')
})

test('real npm installs new local contents at the same package version on consecutive runs', (t) => {
  const f = fixture(t)
  const core = path.join(f.repoRoot, 'packages/core')
  writeJson(path.join(core, 'package.json'), { name: '@datadog/flagging-core', version: '1.0.0', main: 'index.js' })
  writeJson(path.join(f.template, 'package.json'), { name: 'flagging-core-react-native-example', private: true })
  const run = (command, args, options) => {
    if (command === 'git') return 'abc123\n'
    if (command === 'npm' && args[0] === 'run') return '' // Type-checking is covered with the real Expo app.
    const env = { ...process.env, npm_config_cache: path.join(f.root, 'npm-cache') }
    if (command === process.execPath) {
      // Only replace the expensive core build with a tiny real package. npm pack
      // and install still run, so this exercises npm's file-dependency cache.
      const packed = JSON.parse(
        execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', f.appDir], {
          cwd: core,
          env,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      )
      fs.renameSync(path.join(f.appDir, packed[0].filename), args.at(-1))
      return ''
    }
    return execFileSync(command, args, { cwd: options.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  let previousTarball
  for (const contents of ['first build', 'second build']) {
    fs.writeFileSync(path.join(core, 'index.js'), `module.exports = ${JSON.stringify(contents)}\n`)
    prepareExample({ repoRoot: f.repoRoot, cacheRoot: f.cacheRoot, run, log() {} })
    const installed = path.join(f.appDir, 'node_modules/@datadog/flagging-core')
    assert.equal(fs.lstatSync(installed).isSymbolicLink(), false)
    assert.match(fs.readFileSync(path.join(installed, 'index.js'), 'utf8'), new RegExp(contents))
    assert.equal(readJson(path.join(installed, 'package.json')).version, '1.0.0')
    const info = readJson(path.join(f.appDir, 'build-info.json'))
    const manifest = readJson(path.join(f.appDir, 'package.json'))
    const lock = readJson(path.join(f.appDir, 'package-lock.json'))
    assert.ok(manifest.dependencies['@datadog/flagging-core'].endsWith(info.tarball))
    assert.ok(lock.packages['node_modules/@datadog/flagging-core'].resolved.endsWith(info.tarball))
    if (previousTarball) assert.equal(fs.existsSync(path.join(f.appDir, previousTarball)), false)
    previousTarball = info.tarball
  }
})
