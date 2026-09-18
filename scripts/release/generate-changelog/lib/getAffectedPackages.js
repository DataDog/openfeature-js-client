const fs = require('node:fs')
const path = require('node:path')

const { packagesDirectoryNames } = require('../../../lib/packagesDirectoryNames')
const { commandSync } = require('../../../lib/executionUtils')

const PACKAGE_NAME_TO_DIRECTORY = Object.fromEntries(
  packagesDirectoryNames.map((packageDirectoryName) => [
    getPackageJson(packageDirectoryName).name,
    packageDirectoryName,
  ])
)

const PACKAGES_REVERSE_DEPENDENCIES = (() => {
  const result = new Map()
  packagesDirectoryNames.forEach((packageDirectoryName) => {
    for (const dependency of getDependenciesRecursively(packageDirectoryName)) {
      if (!result.has(dependency)) {
        result.set(dependency, new Set())
      }
      result.get(dependency).add(packageDirectoryName)
    }
  })
  return result
})()

exports.getAffectedPackages = (hash) => {
  const changedFiles = commandSync`git diff-tree --no-commit-id --name-only -r ${hash}`.run().trim().split('\n')
  const affectedPackages = new Set()

  changedFiles.forEach((filePath) => {
    const packageDirectoryName = getPackageDirectoryNameFromFilePath(filePath)
    if (!packageDirectoryName) {
      return
    }

    affectedPackages.add(packageDirectoryName)
    for (const dependentPackageDirectoryName of PACKAGES_REVERSE_DEPENDENCIES.get(packageDirectoryName) || []) {
      affectedPackages.add(dependentPackageDirectoryName)
    }
  })

  return Array.from(affectedPackages).sort()
}

function getPackageDirectoryNameFromFilePath(filePath) {
  if (!filePath.startsWith('packages/')) {
    return
  }

  const packageDirectoryName = filePath.split('/')[1]
  return packagesDirectoryNames.includes(packageDirectoryName) ? packageDirectoryName : undefined
}

function getPackageJson(packageDirectoryName) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../../..', 'packages', packageDirectoryName, 'package.json'), {
      encoding: 'utf-8',
    })
  )
}

function getDependenciesRecursively(packageDirectoryName, visited = new Set()) {
  if (visited.has(packageDirectoryName)) {
    return new Set()
  }
  visited.add(packageDirectoryName)

  const dependencies = new Set()
  for (const dependencyPackageName of Object.keys(getPackageJson(packageDirectoryName).dependencies || {})) {
    const dependencyPackageDirectoryName = PACKAGE_NAME_TO_DIRECTORY[dependencyPackageName]
    if (!dependencyPackageDirectoryName) {
      continue
    }

    dependencies.add(dependencyPackageDirectoryName)
    for (const transitiveDependency of getDependenciesRecursively(dependencyPackageDirectoryName, visited)) {
      dependencies.add(transitiveDependency)
    }
  }

  return dependencies
}
