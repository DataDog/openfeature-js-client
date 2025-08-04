const { runMain } = require('../lib/executionUtils')
const { modifyFile } = require('../lib/filesUtils')
const { command } = require('../lib/executionUtils')
const { packagesDirectoryNames } = require('../lib/packagesDirectoryNames')

const JSON_FILES = packagesDirectoryNames.map((packageName) => `./packages/${packageName}/package.json`)

// This script updates the peer dependency versions between packages to match the new
// versions during a release. Since we're using fixed versioning, we need to
// read the version from lerna.json and update all packages to use that version.
runMain(async () => {
  // Read the version from lerna.json
  const lernaJsonPath = require('node:path').join(__dirname, '../../lerna.json')
  const lernaJson = JSON.parse(await require('node:fs').promises.readFile(lernaJsonPath, 'utf8'))
  const version = lernaJson.version

  console.log('Updating peer dependency versions to', version)
  console.log('JSON_FILES', JSON_FILES)
  // Update peer dependencies
  for (const jsonFile of JSON_FILES) {
    await modifyFile(jsonFile, (content) => updatePackageDependencies(content, version))
  }

  // update yarn.lock to match the updated JSON files
  command`yarn`.run()
})

function updatePackageDependencies(content, version) {
  const json = JSON.parse(content)
  Object.keys(json.peerDependencies || {})
    .filter((key) => key.startsWith('@datadog'))
    .forEach((key) => {
      json.peerDependencies[key] = version
    })
  Object.keys(json.dependencies || {})
    .filter((key) => key.startsWith('@datadog'))
    .forEach((key) => {
      json.dependencies[key] = version
    })
  return `${JSON.stringify(json, null, 2)}\n`
}
