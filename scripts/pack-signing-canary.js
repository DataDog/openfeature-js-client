#!/usr/bin/env node
// Build installable, commit-pinned packages without publishing or changing release versions.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const run = (command, args, cwd = repo, extra = {}) => execFileSync(command, args, { cwd, encoding: 'utf8', ...extra })

function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/pack-signing-canary.js NEW_OUTPUT_DIRECTORY')
  const output = path.resolve(process.argv[2])
  if (fs.existsSync(output)) throw new Error('Output directory already exists')
  if (run('git', ['status', '--porcelain', '--untracked-files=normal']).trim())
    throw new Error('Commit changes and initialize pinned submodules before packaging')
  const commit = run('git', ['rev-parse', 'HEAD']).trim()
  const env = { ...process.env, BUILD_MODE: 'canary' }
  for (const name of ['@datadog/flagging-core', '@datadog/openfeature-browser'])
    run('yarn', ['workspace', name, 'build'], repo, { env, stdio: 'inherit' })
  fs.mkdirSync(output, { recursive: true })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffe-signing-canary-'))
  try {
    const packages = []
    let coreVersion
    for (const name of ['core', 'browser']) {
      const source = path.join(repo, 'packages', name)
      const dest = path.join(temp, name)
      fs.mkdirSync(dest)
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
      manifest.version += `-signing-qa.${commit}`
      delete manifest.scripts
      if (name === 'core') coreVersion = manifest.version
      else manifest.dependencies['@datadog/flagging-core'] = coreVersion
      fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      for (const entry of ['cjs', 'esm', 'bundle', 'LICENSE', 'README.md']) {
        if (fs.existsSync(path.join(source, entry)))
          fs.cpSync(path.join(source, entry), path.join(dest, entry), { recursive: true })
      }
      const result = JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], dest)
      )[0]
      packages.push({
        name: manifest.name,
        version: manifest.version,
        file: result.filename,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(output, result.filename)))
          .digest('hex'),
      })
    }
    fs.writeFileSync(
      path.join(output, 'manifest.json'),
      `${JSON.stringify({ commit, protocolVersion: 1, packages }, null, 2)}\n`
    )
    console.log(`Created two QA packages and manifest in ${output}. Nothing was published.`)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
