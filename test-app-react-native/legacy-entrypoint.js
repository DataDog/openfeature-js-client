const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const vm = require('vm')
const { rules, precomputed } = require('./configurations')

async function main() {
  const packageRoot = path.dirname(require.resolve('@datadog/flagging-core/package.json'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const legacyEntrypointRoot = path.join(packageRoot, 'rules-based')
  const legacyEntrypoint = JSON.parse(fs.readFileSync(path.join(legacyEntrypointRoot, 'package.json'), 'utf8'))
  const cjsPath = path.resolve(legacyEntrypointRoot, legacyEntrypoint.main)
  const esmPath = path.resolve(legacyEntrypointRoot, legacyEntrypoint.module)
  assert.strictEqual(require.resolve(legacyEntrypointRoot), cjsPath)
  assert.notStrictEqual(cjsPath, require.resolve('@datadog/flagging-core/rules-based'))
  assert.strictEqual(
    path.resolve(legacyEntrypointRoot, legacyEntrypoint.types),
    path.resolve(packageRoot, packageJson.exports['./rules-based'].types)
  )
  assert.ok(fs.statSync(path.resolve(legacyEntrypointRoot, legacyEntrypoint.types)).isFile())

  const cjsSource = fs.readFileSync(cjsPath, 'utf8')
  for (const file of [cjsPath, esmPath]) {
    // Bundling must retain the original dependency notices, not silently strip them.
    const source = fs.readFileSync(file, 'utf8')
    assert.match(source, /Copyright[^\n]*Buf Technologies/)
    assert.match(source, /Redistribution and use in source and binary forms/)
    assert.ok(fs.statSync(`${file}.map`).isFile(), `Missing packed source map: ${file}`)
  }

  // No external module loader is available. Any leftover protobuf /wire or /codegenv2
  // require would fail here, even though Node itself understands their exports maps.
  const sandbox = {
    module: { exports: {} },
    BigInt: undefined,
    TextEncoder: undefined,
    TextDecoder: undefined,
    require(specifier) {
      throw new Error(`Compatibility bundle has an external dependency: ${specifier}`)
    },
  }
  sandbox.exports = sandbox.module.exports
  vm.runInNewContext(cjsSource, sandbox, { filename: cjsPath, timeout: 10000 })

  const modern = require('@datadog/flagging-core/rules-based')
  const implementations = [
    require(legacyEntrypointRoot),
    await import(pathToFileURL(esmPath).href),
    sandbox.module.exports,
  ]
  const wires = [
    JSON.stringify(rules),
    JSON.stringify(precomputed),
    JSON.stringify({ ...rules, precomputed: precomputed.precomputed }),
    JSON.stringify({ version: 1, rules: { response: 'invalid protobuf' }, precomputed: precomputed.precomputed }),
    JSON.stringify({ version: 99 }),
    '{}',
    'not json',
  ]

  for (const implementation of implementations) {
    assert.deepStrictEqual(Object.keys(implementation).sort(), Object.keys(modern).sort())
    for (const wire of wires) {
      const expected = modern.configurationFromString(wire)
      const actual = implementation.configurationFromString(wire)
      // Compare portable representations, not realm-specific prototypes or bigint/string
      // int64 representations used internally when native BigInt is unavailable.
      assert.strictEqual(implementation.configurationToString(actual), modern.configurationToString(expected))
      assert.strictEqual(
        JSON.stringify(implementation.getPrecomputedContext(actual)),
        JSON.stringify(modern.getPrecomputedContext(expected))
      )
      for (const field of ['configurationError', 'rulesError', 'precomputedError']) {
        assert.strictEqual(actual[field], expected[field])
      }
    }
  }

  console.log('Packed legacy CJS/ESM parsers match modern exports and need no external module loader')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
