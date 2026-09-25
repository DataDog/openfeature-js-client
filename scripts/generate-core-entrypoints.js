#!/usr/bin/env node

const path = require('node:path')
const { synchronizeCoreEntrypoints } = require('./lib/coreEntrypoints')

try {
  const check = process.argv.includes('--check')
  const entries = synchronizeCoreEntrypoints(path.resolve(__dirname, '../packages/core'), { check })
  console.log(`${check ? 'Checked' : 'Generated'} packaging for ${entries.length} core subpath entrypoint(s).`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
