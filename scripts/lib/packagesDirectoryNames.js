const fs = require('fs')
const path = require('path')

const packagesDirectory = path.join(__dirname, '../../packages')

const packagesDirectoryNames = fs.readdirSync(packagesDirectory, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory())
  .map(dirent => dirent.name)

module.exports = {
  packagesDirectoryNames
} 