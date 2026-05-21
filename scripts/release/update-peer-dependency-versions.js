const { runMain } = require('../lib/executionUtils')
const { modifyFile } = require('../lib/filesUtils')
const { command } = require('../lib/executionUtils')
const { packagesDirectoryNames } = require('../lib/packagesDirectoryNames')
const fs = require('node:fs')
const path = require('node:path')

const JSON_FILES = packagesDirectoryNames.map((packageName) => `./packages/${packageName}/package.json`)

// This script updates internal dependency versions between packages to use exact versions.
// With independent versioning, each package has its own version in its package.json.
// This script reads each package's version and updates internal dependencies to match.
runMain(async () => {
  // Build a map of package name -> version by reading each package's package.json
  const packageVersions = {}
  for (const packageDir of packagesDirectoryNames) {
    const packageJsonPath = path.join(__dirname, '../../packages', packageDir, 'package.json')
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'))
    packageVersions[packageJson.name] = packageJson.version
  }

  console.log('Package versions:', packageVersions)

  // Internal packages that should use exact versions
  const internalPackages = ['@datadog/openfeature-browser', '@datadog/flagging-core', '@datadog/openfeature-node-server']

  // Update internal dependencies in each package
  for (const jsonFile of JSON_FILES) {
    await modifyFile(jsonFile, (content) => updatePackageDependencies(content, packageVersions, internalPackages))
  }

  // update yarn.lock to match the updated JSON files
  command`yarn`.run()
})

function updatePackageDependencies(content, packageVersions, internalPackages) {
  const json = JSON.parse(content)

  // Update peerDependencies to exact versions
  Object.keys(json.peerDependencies || {})
    .filter((key) => internalPackages.includes(key))
    .forEach((key) => {
      if (packageVersions[key]) {
        json.peerDependencies[key] = packageVersions[key]
      }
    })

  // Update dependencies to exact versions
  Object.keys(json.dependencies || {})
    .filter((key) => internalPackages.includes(key))
    .forEach((key) => {
      if (packageVersions[key]) {
        json.dependencies[key] = packageVersions[key]
      }
    })

  return `${JSON.stringify(json, null, 2)}\n`
}
