#!/usr/bin/env node

// Checks the browser CDN bundle after `yarn build:bundle`:
// - the main file stays within the gzip budget for the default provider;
// - the main file does not contain the response signing verifier or its ASN.1 libraries;
// - the verifier ships as a separate chunk next to the main file;
// - the main file defines DD_FLAGGING when the page gives no script URL, and loads the chunk from the script directory
//   when it does.

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

const PAGE_URL = 'https://app.example/page/'
const SCRIPT_URL = 'https://cdn.example/v1/datadog-openfeature-browser.js?v=1'
const STAGING_OBSERVE = {
  clientToken: 'pub0123456789abcdef0123456789abcdef',
  site: 'datad0g.com',
  experimentalResponseSigning: { mode: 'observe' },
}

/** Runs the main file in jsdom, with or without document.currentScript, and returns the chunk script URLs. */
function loadCdnBundle(main, scriptUrl) {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only', url: PAGE_URL })
  const { window } = dom
  try {
    let currentScript = null
    if (scriptUrl) {
      currentScript = window.document.createElement('script')
      currentScript.src = scriptUrl
    }
    Object.defineProperty(window.document, 'currentScript', { configurable: true, get: () => currentScript })
    try {
      window.eval(main.toString('utf8'))
    } catch (error) {
      return { error: error.message }
    }
    Object.defineProperty(window.document, 'currentScript', { configurable: true, get: () => null })
    if (typeof window.DD_FLAGGING?.Provider !== 'function') return { error: 'DD_FLAGGING is not defined' }
    // On staging, observe mode starts to load the verifier chunk when the provider is created.
    new window.DD_FLAGGING.Provider(STAGING_OBSERVE)
    return { chunkUrls: [...window.document.querySelectorAll('script[src]')].map((script) => script.src) }
  } finally {
    window.close()
  }
}

function checkCdnBundleLoad(bundleDirectory) {
  const errors = []
  const main = fs.readFileSync(path.join(bundleDirectory, MAIN_FILE))
  for (const [scriptUrl, base] of [
    [undefined, new URL('chunks/', PAGE_URL).href],
    [SCRIPT_URL, new URL('chunks/', SCRIPT_URL).href],
  ]) {
    const page = scriptUrl ? `a page with script URL ${scriptUrl}` : 'a page without a script URL'
    const { error, chunkUrls } = loadCdnBundle(main, scriptUrl)
    if (error) errors.push(`${MAIN_FILE} does not load on ${page}: ${error}`)
    else if (!chunkUrls.length || chunkUrls.some((url) => !url.startsWith(base)))
      errors.push(`On ${page}, the verifier chunk URLs are not in ${base}: ${chunkUrls.join(', ') || 'none'}`)
  }
  return errors
}

function main() {
  const bundleDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'packages', 'browser', 'bundle'))
  const { mainGzip, chunks, errors } = checkCdnBundle(bundleDirectory)
  errors.push(...checkCdnBundleLoad(bundleDirectory))
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

module.exports = { checkCdnBundle, checkCdnBundleLoad, BASE_GZIP_BYTES, GZIP_BUDGET_BYTES, VERIFIER_MARKERS }
