'use strict'

const fs = require('node:fs')
const path = require('node:path')

const forbiddenPackageNames = [/^@datadog\/browser-/, /^@datadog\/js-core$/, /^@datadog\/openfeature-browser$/]
const browserSdkRepository = /github\.com[/:]DataDog\/browser-sdk(?:\.git)?$/i

const found = new Set()
const visited = new Set()

function inspectPackage(packageDirectory) {
  let realDirectory
  try {
    realDirectory = fs.realpathSync(packageDirectory)
  } catch {
    return
  }

  if (visited.has(realDirectory)) return
  visited.add(realDirectory)

  const manifestPath = path.join(realDirectory, 'package.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
    const isBrowserSdkDependency =
      forbiddenPackageNames.some((pattern) => pattern.test(manifest.name)) ||
      browserSdkRepository.test(repository ?? '')
    if (isBrowserSdkDependency) {
      found.add(manifest.name)
    }
  }

  inspectNodeModules(path.join(realDirectory, 'node_modules'))
}

function inspectNodeModules(nodeModulesDirectory) {
  if (!fs.existsSync(nodeModulesDirectory)) return

  for (const entry of fs.readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue

    const entryPath = path.join(nodeModulesDirectory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          inspectPackage(path.join(entryPath, scopedEntry.name))
        }
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      inspectPackage(entryPath)
    }
  }
}

inspectNodeModules(path.resolve(process.argv[2] ?? 'node_modules'))

if (found.size > 0) {
  console.error('ERROR: Node packages must not install browser SDK dependencies')
  for (const packageName of [...found].sort()) console.error(packageName)
  process.exit(1)
}

console.log('Verified Node packages do not install browser SDK dependencies')
