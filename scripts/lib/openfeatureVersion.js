const fs = require('node:fs')
const path = require('node:path')

/**
 * Read the version for a specific package directory, or return the highest
 * version across all packages as a fallback.
 */
function getPackageVersion(packageDirName) {
  if (packageDirName) {
    const pkgPath = path.join(__dirname, '../../packages', packageDirName, 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version
  }

  // Fallback: return the highest version across all packages
  const packagesDir = path.join(__dirname, '../../packages')
  const versions = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(fs.readFileSync(path.join(packagesDir, d.name, 'package.json'), 'utf8')).version)

  versions.sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pb[i] - pa[i]
    }
    return 0
  })

  return versions[0]
}

module.exports = {
  getPackageVersion,
  // For backwards compatibility with changelog generation
  openfeatureVersion: getPackageVersion(),
}
