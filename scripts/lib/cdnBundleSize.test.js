const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { checkCdnBundle, VERIFIER_MARKERS } = require('../check-cdn-bundle-size')

function bundle({ main, chunk }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'cdn-bundle-'))
  writeFileSync(path.join(directory, 'datadog-openfeature-browser.js'), main)
  if (chunk !== undefined) {
    mkdirSync(path.join(directory, 'chunks'))
    writeFileSync(path.join(directory, 'chunks', 'verifier-abc-datadog-openfeature-browser.js'), chunk)
  }
  return directory
}

test('accepts a main file without the verifier and a chunk with it', (t) => {
  const directory = bundle({ main: 'provider()', chunk: VERIFIER_MARKERS.join(';') })
  t.after(() => rmSync(directory, { recursive: true }))
  assert.deepEqual(checkCdnBundle(directory).errors, [])
})

test('rejects verifier code in the main file', (t) => {
  const directory = bundle({ main: VERIFIER_MARKERS.join(';'), chunk: VERIFIER_MARKERS.join(';') })
  t.after(() => rmSync(directory, { recursive: true }))
  assert.match(checkCdnBundle(directory).errors.join('\n'), /contains response signing verifier code/)
})

test('rejects a bundle without the verifier chunk', (t) => {
  const directory = bundle({ main: 'provider()' })
  t.after(() => rmSync(directory, { recursive: true }))
  assert.match(checkCdnBundle(directory).errors.join('\n'), /No chunk contains the response signing verifier/)
})

test('rejects a main file over the gzip budget', (t) => {
  const directory = bundle({ main: 'provider()', chunk: VERIFIER_MARKERS.join(';') })
  t.after(() => rmSync(directory, { recursive: true }))
  assert.match(checkCdnBundle(directory, { budget: 1 }).errors.join('\n'), /over the 1 B budget/)
})
