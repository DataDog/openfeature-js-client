const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const templateFiles = [
  'App.tsx',
  'app.json',
  'checks.ts',
  'index.js',
  'metro.config.js',
  'package.json',
  'README.md',
  'tsconfig.json',
]
const markerName = '.flagging-core-example.json'

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function getAppDirectory(repoRoot, cacheRoot) {
  const checkout = fs.realpathSync(repoRoot)
  const key = createHash('sha256').update(checkout).digest('hex').slice(0, 16)
  // Canonicalize even a not-yet-created cache, including /tmp -> /private/tmp
  // on macOS. This also catches cache paths that alias back into the checkout.
  let ancestor = path.resolve(cacheRoot)
  const missing = []
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  return path.join(fs.realpathSync(ancestor), ...missing, 'datadog', 'flagging-core-react-native', key)
}

function runCommand(command, args, { cwd, capture = false }) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  })
}

function prepareExample({
  repoRoot,
  cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  run = runCommand,
  log = console.log,
}) {
  repoRoot = fs.realpathSync(repoRoot)
  const appDir = getAppDirectory(repoRoot, cacheRoot)
  if (isWithin(repoRoot, appDir))
    throw new Error('The generated app must be outside the repository. Change XDG_CACHE_HOME.')
  fs.mkdirSync(appDir, { recursive: true })
  if (isWithin(repoRoot, fs.realpathSync(appDir))) throw new Error('The app cache resolves inside the repository.')

  const marker = path.join(appDir, markerName)
  if (fs.existsSync(marker)) {
    const owner = JSON.parse(fs.readFileSync(marker, 'utf8'))
    if (owner.repoRoot !== repoRoot || owner.version !== 1) {
      throw new Error(`Refusing to overwrite an app owned by another checkout: ${appDir}`)
    }
  } else {
    if (fs.readdirSync(appDir).length > 0) throw new Error(`Refusing to overwrite an unrecognized directory: ${appDir}`)
    fs.writeFileSync(marker, `${JSON.stringify({ version: 1, repoRoot }, null, 2)}\n`, { flag: 'wx' })
  }

  // Serialize refreshes of this checkout. A killed process can leave the lock;
  // only remove it manually after confirming no other preparation is running.
  const lock = path.join(appDir, '.prepare.lock')
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Preparation is already running. If it was interrupted, remove the stale lock: ${lock}`)
  }

  try {
    log(`Preparing the manual React Native app in ${appDir}`)
    log("Stop this app's Metro server before refreshing it; restart with npm start afterward.")
    const tarballName = `core-${randomUUID()}.tgz`
    const tarball = path.join(appDir, tarballName)
    log('Building and packing the current local @datadog/flagging-core...')
    run(process.execPath, [path.join(repoRoot, '.yarn/releases/yarn-4.10.3.cjs'), 'pack', '--filename', tarball], {
      cwd: path.join(repoRoot, 'packages/core'),
    })

    const git = (...args) => run('git', args, { cwd: repoRoot, capture: true }).trim()
    const info = {
      commit: git('rev-parse', '--short', 'HEAD'),
      dirty: git('status', '--porcelain').length > 0,
      packedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
      tarball: tarballName,
    }

    // These files belong to the tracked template. Preserve node_modules, the
    // lockfile and Expo state, but always refresh the UI, tests and dependency pins.
    const fixture = path.join(repoRoot, 'test-app-react-native')
    for (const file of templateFiles) fs.copyFileSync(path.join(fixture, 'manual', file), path.join(appDir, file))
    fs.copyFileSync(path.join(fixture, 'configurations.js'), path.join(appDir, 'configurations.js'))

    // The filename changes even if the package version does not. npm therefore
    // replaces the installed core rather than reusing an old file: dependency.
    log('Installing the fresh tarball (reusing the app and its other dependencies)...')
    run('npm', ['install', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', `./${tarballName}`], {
      cwd: appDir,
    })
    fs.writeFileSync(path.join(appDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)
    run('npm', ['run', 'typecheck'], { cwd: appDir })

    // Keep only the tarball now referenced by package.json/package-lock.json.
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (entry.isFile() && /^core-[0-9a-f-]{36}\.tgz$/.test(entry.name) && entry.name !== tarballName) {
        fs.unlinkSync(path.join(appDir, entry.name))
      }
    }
    return appDir
  } finally {
    fs.unlinkSync(lock)
  }
}

if (require.main === module) {
  try {
    if (process.argv.length > 2) throw new Error('Usage: yarn example:react-native (no arguments)')
    const appDir = prepareExample({ repoRoot: path.resolve(__dirname, '..') })
    const quotedDirectory = `'${appDir.replace(/'/g, "'\\''")}'`
    console.log(`\nApp ready. In your terminal, run:\n\n  cd ${quotedDirectory}\n  npm start\n`)
    console.log('Press i for iOS, a for Android, or scan the QR code with Expo Go.')
    console.log('The screen should say Hermes and ALL CHECKS PASSED.')
    console.log(
      'After SDK changes: stop Metro, rerun yarn example:react-native, then restart npm start in this same directory.'
    )
    console.log(`The generated app is retained until you remove it: ${appDir}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { getAppDirectory, prepareExample }
