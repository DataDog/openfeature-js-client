const fs = require('node:fs')
const path = require('node:path')

const packagesDirectory = path.join(__dirname, '../../packages')

const packagesDirectoryNames = fs
  .readdirSync(packagesDirectory, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name)

module.exports = {
  packagesDirectoryNames,
}
