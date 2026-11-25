#!/usr/bin/env node

// Checks the browser CDN bundle after `yarn build:bundle`:
// - the main file stays within the gzip budget for the default provider;
// - the main file does not contain the response signing verifier or its ASN.1 libraries;
// - the verifier ships as a separate chunk next to the main file.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const MAIN_FILE = 'datadog-openfeature-browser.js'
// zlib level 9 size of the main file on main at 76a6583, before response signing.
const BASE_GZIP_BYTES = 49979
// Response signing adds its option checks, state checks and the chunk loader to the main file. The verifier is a
// dynamic chunk while signing is experimental. Raise this budget only in a reviewed change.
const GZIP_BUDGET_BYTES = 54800
const VERIFIER_MARKERS = ['datadog.feature-flags.precomputed-assignments.v1', 'asn1js']

function gzipSize(content) {
  return zlib.gzipSync(content, { level: 9 }).length
}

function checkCdnBundle(bundleDirectory, { budget = GZIP_BUDGET_BYTES } = {}) {
  const errors = []
  const main = fs.readFileSync(path.join(bundleDirectory, MAIN_FILE))
  const mainGzip = gzipSize(main)
  if (mainGzip > budget) errors.push(`${MAIN_FILE} is ${mainGzip} B gzip, over the ${budget} B budget`)
  const eagerMarkers = VERIFIER_MARKERS.filter((marker) => main.includes(marker))
  if (eagerMarkers.length)
    errors.push(`${MAIN_FILE} contains response signing verifier code: ${eagerMarkers.join(', ')}`)

  const chunkDirectory = path.join(bundleDirectory, 'chunks')
  const chunks = fs.existsSync(chunkDirectory)
    ? fs.readdirSync(chunkDirectory).filter((name) => name.endsWith(`-${MAIN_FILE}`))
    : []
  const chunkContent = Buffer.concat(chunks.map((name) => fs.readFileSync(path.join(chunkDirectory, name))))
  const missingMarkers = VERIFIER_MARKERS.filter((marker) => !chunkContent.includes(marker))
  if (missingMarkers.length)
    errors.push(`No chunk contains the response signing verifier: ${missingMarkers.join(', ')}`)

  return { mainGzip, chunks, errors }
}

function main() {
  const bundleDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'packages', 'browser', 'bundle'))
  const { mainGzip, chunks, errors } = checkCdnBundle(bundleDirectory)
  const delta = mainGzip - BASE_GZIP_BYTES
  console.log(
    `${MAIN_FILE}: ${mainGzip} B gzip (base ${BASE_GZIP_BYTES} B, ${delta >= 0 ? '+' : ''}${delta} B, budget ${GZIP_BUDGET_BYTES} B)`
  )
  for (const chunk of chunks) {
    console.log(`chunks/${chunk}: ${gzipSize(fs.readFileSync(path.join(bundleDirectory, 'chunks', chunk)))} B gzip`)
  }
  if (errors.length) {
    for (const error of errors) console.error(error)
    process.exit(1)
  }
}

if (require.main === module) main()

module.exports = { checkCdnBundle, BASE_GZIP_BYTES, GZIP_BUDGET_BYTES, VERIFIER_MARKERS }
