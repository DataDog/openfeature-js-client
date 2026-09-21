const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const repositoryRoot = path.resolve(__dirname, '../..')
const buildEnvPath = path.join(__dirname, 'buildEnv.js')
const replacementScript = path.join(repositoryRoot, 'scripts/build/replace-build-env.js')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()

function environment(buildMode, sdkSetup = 'npm') {
  const env = { ...process.env, SDK_SETUP: sdkSetup }
  delete env.BUILD_MODE
  if (buildMode !== undefined) env.BUILD_MODE = buildMode
  return env
}

function resolveVersion(cwd, buildMode) {
  return spawnSync(
    process.execPath,
    ['-e', `console.log(require(${JSON.stringify(buildEnvPath)}).getBuildEnvValue('SDK_VERSION'))`],
    { cwd, env: environment(buildMode), encoding: 'utf8' }
  )
}

function temporaryPackage(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'flagging-build-env-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

for (const packageName of ['browser', 'core', 'node-server']) {
  const directory = path.join(repositoryRoot, 'packages', packageName)
  const { version } = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))

  for (const buildMode of [undefined, 'dev', 'release', 'canary']) {
    test(`${packageName} uses its own version in ${buildMode ?? 'default'} mode`, () => {
      const result = resolveVersion(directory, buildMode)
      const expected = buildMode === 'release' ? version : buildMode === 'canary' ? `${version}-${commit}` : 'dev'
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), expected)
    })
  }
}

test('release builds fail when package.json is missing', (t) => {
  const result = resolveVersion(temporaryPackage(t), 'release')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /package\.json/)
})

test('release builds fail when package.json is malformed', (t) => {
  const directory = temporaryPackage(t)
  writeFileSync(path.join(directory, 'package.json'), '{')
  const result = resolveVersion(directory, 'release')
  assert.notEqual(result.status, 0)
})

for (const version of [undefined, '', 123]) {
  test(`release builds fail for a missing or invalid package version: ${version}`, (t) => {
    const directory = temporaryPackage(t)
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }))
    const result = resolveVersion(directory, 'release')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Missing or invalid version in/)
  })
}

for (const format of ['cjs', 'esm']) {
  test(`replaces ${format} build placeholders with the package release version`, (t) => {
    const directory = temporaryPackage(t)
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '9.8.7-rc.1' }))
    mkdirSync(path.join(directory, format))
    const outputFile = path.join(directory, format, 'index.js')
    writeFileSync(
      outputFile,
      'console.log(JSON.stringify({ version: __BUILD_ENV__SDK_VERSION__, setup: __BUILD_ENV__SDK_SETUP__ }))'
    )
    execFileSync(process.execPath, [replacementScript, format], {
      cwd: directory,
      env: environment('release'),
    })
    const output = execFileSync(process.execPath, [outputFile], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), { version: '9.8.7-rc.1', setup: 'npm' })
  })
}

test('webpack injects the browser package release version into CDN builds', (t) => {
  const directory = temporaryPackage(t)
  const inputFile = path.join(directory, 'input.js')
  const outputFile = path.join(directory, 'output.js')
  const packageDirectory = path.join(repositoryRoot, 'packages/browser')
  const { version } = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  writeFileSync(
    inputFile,
    'console.log(JSON.stringify({ version: __BUILD_ENV__SDK_VERSION__, setup: __BUILD_ENV__SDK_SETUP__ }))'
  )
  const script = `
    const webpack = require(${JSON.stringify(require.resolve('webpack'))})
    const { createDefinePlugin } = require(${JSON.stringify(path.join(repositoryRoot, 'webpack.base.js'))})
    webpack({
      mode: 'production',
      entry: ${JSON.stringify(inputFile)},
      output: { path: ${JSON.stringify(directory)}, filename: 'output.js' },
      plugins: [createDefinePlugin()],
    }, (error, stats) => {
      if (error || stats.hasErrors()) {
        console.error(error || stats.toString())
        process.exitCode = 1
      }
    })
  `
  execFileSync(process.execPath, ['-e', script], {
    cwd: packageDirectory,
    env: environment('release', 'cdn'),
  })
  const output = execFileSync(process.execPath, [outputFile], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(output), { version, setup: 'cdn' })
})
