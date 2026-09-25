const fs = require('node:fs')
const path = require('node:path')

const GENERATED_BY = 'scripts/generate-core-entrypoints.js'
const RESERVED_DIRECTORIES = new Set(['src', 'test', 'cjs', 'esm', 'dist', 'bundle', 'node_modules'])

function entrypointName(subpath) {
  const name = subpath.startsWith('./') ? subpath.slice(2) : ''
  const segments = name.split('/')
  if (
    !name ||
    segments.some((segment) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(segment)) ||
    RESERVED_DIRECTORIES.has(segments[0])
  ) {
    throw new Error(
      `Unsupported core export ${JSON.stringify(subpath)}: use a concrete, non-reserved ./name[/subpath].`
    )
  }
  return name
}

/** package.json.exports is the only registry of public entrypoints. */
function getCoreEntrypoints(packageJson) {
  if (!packageJson.exports || !packageJson.exports['.']) {
    throw new Error('Core package.json must declare its default "." export.')
  }
  return Object.entries(packageJson.exports)
    .filter(([subpath]) => subpath !== '.' && subpath !== './package.json')
    .map(([subpath, targets]) => {
      const name = entrypointName(subpath)
      const source = typeof targets?.import === 'string' && /^\.\/esm\/(.+)\.js$/.exec(targets.import)?.[1]
      if (
        !source ||
        source.split('/').some((segment) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(segment)) ||
        targets.require !== `./cjs/${source}.js` ||
        targets.types !== `./cjs/${source}.d.ts` ||
        (targets.default !== undefined && targets.default !== targets.import) ||
        Object.keys(targets).some((key) => !['types', 'import', 'require', 'default'].includes(key))
      ) {
        throw new Error(
          `Core export ${subpath} must map import, require, and types to the same esm/*.js, cjs/*.js, and cjs/*.d.ts source.`
        )
      }
      return { subpath, name, source, ...targets }
    })
    .sort((a, b) => (a.subpath < b.subpath ? -1 : a.subpath > b.subpath ? 1 : 0))
}

function fallbackManifest(entry) {
  const relative = (target) => path.posix.relative(entry.name, target)
  return {
    _generatedBy: GENERATED_BY,
    main: relative(`bundle/legacy/cjs/${entry.name}.js`),
    module: relative(`bundle/legacy/esm/${entry.name}.js`),
    types: relative(entry.types.slice(2)),
  }
}

function generatedPackageJson(packageJson, entries) {
  return {
    ...packageJson,
    files: ['cjs/', 'esm/', 'bundle/', ...new Set(entries.map((entry) => `${entry.name.split('/')[0]}/`)), '*.d.ts'],
    sideEffects:
      packageJson.sideEffects === undefined || packageJson.sideEffects === true
        ? true
        : [
            ...(packageJson.sideEffects === false ? [] : packageJson.sideEffects).filter(
              (file) => !file.startsWith('./bundle/legacy/')
            ),
            ...entries.flatMap((entry) => ['cjs', 'esm'].map((format) => `./bundle/legacy/${format}/${entry.name}.js`)),
          ],
    typesVersions: { '*': Object.fromEntries(entries.map((entry) => [entry.name, [entry.types.slice(2)]])) },
  }
}

// Never follow a generated output path through a symlink or overwrite an unrelated package.
function assertWritablePath(packageRoot, filename) {
  let current = packageRoot
  for (const segment of path.relative(packageRoot, filename).split(path.sep)) {
    current = path.join(current, segment)
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to generate entrypoint metadata through a symlink: ${current}`)
    }
  }
}

function synchronizeCoreEntrypoints(packageRoot, { check = false } = {}) {
  const packagePath = path.join(packageRoot, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const entries = getCoreEntrypoints(packageJson)
  const writes = new Map()
  const removals = []
  const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`
  writes.set(packagePath, serialize(generatedPackageJson(packageJson, entries)))

  for (const entry of entries) {
    const source = path.join(packageRoot, 'src', `${entry.source}.ts`)
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Core export ${entry.subpath} has no source file: ${source}`)
    }
    writes.set(path.join(packageRoot, entry.name, 'package.json'), serialize(fallbackManifest(entry)))
  }

  const names = new Set(entries.map((entry) => entry.name))
  for (const name of Object.keys(packageJson.typesVersions?.['*'] || {})) {
    if (!names.has(name)) {
      const filename = path.join(packageRoot, entrypointName(`./${name}`), 'package.json')
      if (fs.existsSync(filename)) removals.push(filename)
    }
  }

  const changes = []
  for (const filename of [...writes.keys(), ...removals]) {
    assertWritablePath(packageRoot, filename)
    const previous = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : undefined
    if (filename !== packagePath && previous !== undefined && JSON.parse(previous)._generatedBy !== GENERATED_BY) {
      throw new Error(`Refusing to overwrite an unowned entrypoint manifest: ${filename}`)
    }
    if (previous !== writes.get(filename)) changes.push(filename)
  }
  if (check) {
    if (changes.length) {
      throw new Error(
        `Core entrypoint metadata is out of date:\n${changes.map((file) => path.relative(packageRoot, file)).join('\n')}\n` +
          'Run yarn workspace @datadog/flagging-core build and commit the generated metadata.'
      )
    }
    return entries
  }
  for (const filename of changes) {
    if (writes.has(filename)) {
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, writes.get(filename))
    } else {
      // Only remove our manifest, never a whole directory that could contain user files.
      fs.unlinkSync(filename)
    }
  }
  return entries
}

module.exports = { getCoreEntrypoints, fallbackManifest, synchronizeCoreEntrypoints }
