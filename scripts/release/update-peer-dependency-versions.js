const { runMain } = require('../lib/executionUtils')
const { modifyFile } = require('../lib/filesUtils')
const { command } = require('../lib/executionUtils')
const { packagesDirectoryNames } = require('../lib/packagesDirectoryNames')
const path = require('node:path')
const fs = require('node:fs')

const JSON_FILES = packagesDirectoryNames.map((packageName) => `./packages/${packageName}/package.json`)

// This script updates the dependency versions between internal packages to match
// the actual versions in each dependency's package.json. With independent versioning,
// each package has its own version, so we read from each package.json directly.
runMain(async () => {
  // Build a map of internal package name -> actual version from each package.json
  const internalVersions = {}
  for (const dirName of packagesDirectoryNames) {
    const pkgPath = path.join(__dirname, '../../packages', dirName, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    internalVersions[pkg.name] = pkg.version
  }

  const targetDeps = Object.keys(internalVersions)
  console.log('Internal package versions:', internalVersions)

  // Update dependencies in each package to match actual versions
  for (const jsonFile of JSON_FILES) {
    await modifyFile(jsonFile, (content) => updatePackageDependencies(content, internalVersions, targetDeps))
  }

  // update yarn.lock to match the updated JSON files
  command`yarn`.run()
})

function updatePackageDependencies(content, internalVersions, targetDeps) {
  const json = JSON.parse(content)
  Object.keys(json.peerDependencies || {})
    .filter((key) => targetDeps.includes(key))
    .forEach((key) => {
      json.peerDependencies[key] = internalVersions[key]
    })
  Object.keys(json.dependencies || {})
    .filter((key) => targetDeps.includes(key))
    .forEach((key) => {
      json.dependencies[key] = internalVersions[key]
    })
  return `${JSON.stringify(json, null, 2)}\n`
}
