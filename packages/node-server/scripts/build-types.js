'use strict'

const { execFileSync } = require('node:child_process')
const { rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const packageRoot = path.join(__dirname, '..')
const entryFile = path.join(packageRoot, 'src/.dts-entry.ts')

try {
  for (const entrypoint of ['index', 'rules-based']) {
    writeFileSync(entryFile, `/// <reference path="./global.d.ts" />\nexport * from './${entrypoint}'\n`)
    execFileSync(
      process.execPath,
      [
        require.resolve('dts-bundle-generator/dist/bin/dts-bundle-generator.js'),
        '-o',
        `${entrypoint}.d.ts`,
        entryFile,
        '--external-inlines',
        '@openfeature/core',
        '@openfeature/server-sdk',
        '@datadog/flagging-core',
        '@bufbuild/protobuf',
        '--no-banner',
        '--export-referenced-types',
        'false',
      ],
      { cwd: packageRoot, stdio: 'inherit' }
    )
  }
} finally {
  rmSync(entryFile, { force: true })
}
