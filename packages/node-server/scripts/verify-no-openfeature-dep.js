'use strict'

/**
 * Pre-publish guard: ensures @openfeature/server-sdk and @openfeature/core
 * are NOT declared as runtime dependencies and are NOT imported at runtime.
 *
 * Adding either as a dependency would give dd-trace-js its own copy of the
 * SDK under SSI (Single Step Instrumentation), where dd-trace is installed
 * outside the application's node_modules tree. That copy would have a
 * different identity than the customer's, breaking event emitter sharing.
 *
 * See https://github.com/DataDog/dd-trace-js/pull/9570 for context.
 */

const fs = require('node:fs')
const path = require('node:path')

const FORBIDDEN_PACKAGES = ['@openfeature/server-sdk', '@openfeature/core']
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json')
const CJS_DIR = path.join(__dirname, '..', 'cjs')
const ESM_DIR = path.join(__dirname, '..', 'esm')

let failed = false

function fail(message) {
  console.error(`\x1b[31m[verify-no-openfeature-dep] ERROR: ${message}\x1b[0m`)
  failed = true
}

// --- Check package.json ---
const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))

for (const section of ['dependencies', 'peerDependencies']) {
  if (!pkg[section]) continue
  for (const dep of FORBIDDEN_PACKAGES) {
    if (dep in pkg[section]) {
      fail(
        `"${dep}" is listed in "${section}" in package.json.\n` +
        `  This would install a separate copy under SSI, breaking event emitter\n` +
        `  identity with the customer's @openfeature/server-sdk.\n` +
        `  See https://github.com/DataDog/dd-trace-js/pull/9570 for context.\n` +
        `  If you need OpenFeature types, keep them in "devDependencies" only.`
      )
    }
  }
}

// --- Check compiled .js files for runtime @openfeature imports ---
function checkDir(dir, label) {
  if (!fs.existsSync(dir)) return
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue
    const content = fs.readFileSync(path.join(dir, file), 'utf8')
    // Match require('@openfeature/...') or from '@openfeature/...'
    if (content.includes("@openfeature/")) {
      fail(
        `Runtime @openfeature import found in ${label}/${file}.\n` +
        `  The compiled output must not import from @openfeature/* at runtime.\n` +
        `  All OpenFeature types must be import type only (erased at compile time)\n` +
        `  and the event emitter must use the custom NodeProviderEventEmitter.`
      )
    }
  }
}

checkDir(CJS_DIR, 'cjs')
checkDir(ESM_DIR, 'esm')

if (failed) {
  console.error(
    '\n\x1b[31m[verify-no-openfeature-dep] ' +
    'Publishing blocked. @openfeature/server-sdk must remain a devDependency ' +
    'only. Adding it as a runtime dependency breaks SSI compatibility with ' +
    'dd-trace-js (see https://github.com/DataDog/dd-trace-js/pull/9570).\x1b[0m\n'
  )
  process.exit(1)
} else {
  console.log('\x1b[32m[verify-no-openfeature-dep] OK — no runtime @openfeature dependency.\x1b[0m')
}
