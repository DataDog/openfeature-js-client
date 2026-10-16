const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const vm = require('vm')
const { rules, precomputed } = require('./configurations')

async function checkEntrypoint(packageRoot, packageJson, subpath, targets) {
  const name = subpath.slice(2)
  const specifier = `${packageJson.name}/${name}`
  const entrypointRoot = path.join(packageRoot, name)
  const manifest = JSON.parse(fs.readFileSync(path.join(entrypointRoot, 'package.json'), 'utf8'))
  const cjsPath = path.resolve(entrypointRoot, manifest.main)
  const esmPath = path.resolve(entrypointRoot, manifest.module)
  assert.strictEqual(require.resolve(entrypointRoot), cjsPath)
  assert.strictEqual(require.resolve(specifier), path.resolve(packageRoot, targets.require))
  assert.notStrictEqual(cjsPath, require.resolve(specifier))
  assert.strictEqual(path.resolve(entrypointRoot, manifest.types), path.resolve(packageRoot, targets.types))
  assert.deepStrictEqual(packageJson.typesVersions['*'][name], [targets.types.slice(2)])
  assert.ok(fs.statSync(path.resolve(entrypointRoot, manifest.types)).isFile())

  for (const file of [cjsPath, esmPath]) {
    assert.ok(fs.statSync(file).isFile(), `Missing packed bundle: ${file}`)
    assert.ok(fs.statSync(`${file}.map`).isFile(), `Missing packed source map: ${file}`)
    if (subpath === './rules-based') {
      // Rules-parser dependencies have Apache and BSD notices which must be retained.
      const source = fs.readFileSync(file, 'utf8')
      assert.match(source, /Copyright[^\n]*Buf Technologies/)
      assert.match(source, /Redistribution and use in source and binary forms/)
    }
  }

  const sandbox = {
    module: { exports: {} },
    BigInt: undefined,
    TextEncoder: undefined,
    TextDecoder: undefined,
    require(dependency) {
      throw new Error(`${subpath} compatibility bundle has an external dependency: ${dependency}`)
    },
  }
  sandbox.exports = sandbox.module.exports
  vm.runInNewContext(fs.readFileSync(cjsPath, 'utf8'), sandbox, { filename: cjsPath, timeout: 10000 })

  const modern = require(specifier)
  const implementations = [require(entrypointRoot), await import(pathToFileURL(esmPath).href), sandbox.module.exports]
  for (const implementation of implementations) {
    assert.deepStrictEqual(Object.keys(implementation).sort(), Object.keys(modern).sort(), subpath)
    for (const name of Object.keys(modern))
      assert.strictEqual(typeof implementation[name], typeof modern[name], subpath)
  }
  console.log(`Packed ${subpath}: modern/legacy API and standalone resolution passed`)
  return { modern, implementations }
}

function checkRulesBehavior({ modern, implementations }) {
  // Feature behavior remains explicit; packaging/import coverage is automatic for every export.
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
    for (const wire of wires) {
      const expected = modern.configurationFromString(wire)
      const actual = implementation.configurationFromString(wire)
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
}

async function main() {
  const packageRoot = path.dirname(require.resolve('@datadog/flagging-core/package.json'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const entrypoints = Object.entries(packageJson.exports).filter(
    ([subpath]) => subpath !== '.' && subpath !== './package.json'
  )
  const imports = []
  for (const [subpath, targets] of entrypoints) {
    const result = await checkEntrypoint(packageRoot, packageJson, subpath, targets)
    if (subpath === './rules-based') checkRulesBehavior(result)
    imports.push(`require(${JSON.stringify(`${packageJson.name}${subpath.slice(1)}`)})`)
  }
  // Metro needs statically discoverable imports. Generate them from the packed package,
  // so a new public path is exercised in all six modes without another fixture edit.
  fs.writeFileSync(path.join(__dirname, 'generated-entrypoints.js'), `${imports.join('\n')}\n`)
  console.log(`Validated ${entrypoints.length} packed subpath(s) and generated their Metro imports`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
