const fs = require('fs')
const path = require('path')
const fsPromises = require('fs/promises')
const { command } = require('./executionUtils')

/**
 * @param filePath {string}
 * @param modifier {(content: string) => string | Promise<string>}
 */
async function modifyFile(filePath, modifier) {
  const content = await fsPromises.readFile(filePath, { encoding: 'utf-8' })
  const modifiedContent = await modifier(content)
  if (content !== modifiedContent) {
    await fsPromises.writeFile(filePath, modifiedContent)
    return true
  }
  return false
}

function findOpenFeaturePackageJsonFiles() {
  const manifestPaths = command`git ls-files -- package.json */package.json`.run()
  return manifestPaths
    .trim()
    .split('\n')
    .map((manifestPath) => {
      const absoluteManifestPath = path.join(__dirname, '../..', manifestPath)
      return {
        relativePath: manifestPath,
        path: absoluteManifestPath,
        content: require(absoluteManifestPath),
      }
    })
}

async function forEachFile(directoryPath, callback) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = `${directoryPath}/${entry.name}`
    if (entry.isFile()) {
      await callback(entryPath)
    } else if (entry.isDirectory()) {
      await forEachFile(entryPath, callback)
    }
  }
}

module.exports = {
  modifyFile,
  findOpenFeaturePackageJsonFiles,
  forEachFile
} 