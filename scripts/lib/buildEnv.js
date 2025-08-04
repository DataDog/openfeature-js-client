const { readFileSync } = require('fs')
const path = require('path')
const execSync = require('child_process').execSync
const { command } = require('./executionUtils')

/**
 * Allows to define which sdk_version to send to the intake.
 */
const BUILD_MODES = [
  // Used while developing. This is the default if the BUILD_MODE environment variable is empty.
  'dev',

  // Used for public releases.
  'release',

  // Used on staging and production Datadog web app.
  'canary',
]

/**
 * Allows to define which sdk setup to send to the telemetry.
 */
const SDK_SETUPS = ['npm', 'cdn']

const buildEnvCache = new Map()

const buildEnvFactories = {
  SDK_VERSION: () => {
    switch (getBuildMode()) {
      case 'release':
        return getOpenFeatureVersion()
      case 'canary': {
        const commitSha1 = execSync('git rev-parse HEAD').toString().trim()
        // TODO when tags would allow '+' characters
        //  use build separator (+) instead of prerelease separator (-)
        return `${getOpenFeatureVersion()}-${commitSha1}`
      }
      default:
        return 'dev'
    }
  },
  SDK_SETUP: () => getSdkSetup(),
}

module.exports = {
  buildEnvKeys: Object.keys(buildEnvFactories),

  getBuildEnvValue: (key) => {
    let value = buildEnvCache.get(key)
    if (!value) {
      value = buildEnvFactories[key]()
      buildEnvCache.set(key, value)
    }
    return value
  },
}

function getBuildMode() {
  if (!process.env.BUILD_MODE) {
    return BUILD_MODES[0]
  }
  if (BUILD_MODES.includes(process.env.BUILD_MODE)) {
    return process.env.BUILD_MODE
  }
  console.log(`Invalid build mode "${process.env.BUILD_MODE}". Possible build modes are: ${BUILD_MODES.join(', ')}`)
  process.exit(1)
}

function getSdkSetup() {
  if (!process.env.SDK_SETUP) {
    return SDK_SETUPS[0] // npm
  }
  if (SDK_SETUPS.includes(process.env.SDK_SETUP)) {
    return process.env.SDK_SETUP
  }
  console.log(`Invalid SDK setup "${process.env.SDK_SETUP}". Possible SDK setups are: ${SDK_SETUPS.join(', ')}`)
  process.exit(1)
}

function getOpenFeatureVersion() {
  // For fixed versioning, we'll use the version from lerna.json
  try {
    const lernaJsonPath = path.join(__dirname, '../../lerna.json')
    const lernaJson = JSON.parse(readFileSync(lernaJsonPath, 'utf8'))
    return lernaJson.version
  } catch (error) {
    console.warn('Could not read lerna.json version, using "0.1.0-alpha.2"', error)
    return '0.1.0-alpha.2'
  }
}
