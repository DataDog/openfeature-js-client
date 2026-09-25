const assert = require('assert')
const fs = require('fs')
const path = require('path')

const packageRoot = path.dirname(require.resolve('@datadog/flagging-core/package.json'))
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const legacyEntrypointRoot = path.join(packageRoot, 'rules-based')
const legacyEntrypoint = JSON.parse(fs.readFileSync(path.join(legacyEntrypointRoot, 'package.json'), 'utf8'))

// Resolving an absolute directory bypasses the root package's exports map. This checks
// the physical package.json/main fallback against the packed artifact, without claiming
// that all transitive dependencies can also be resolved by an older Metro version.
assert.strictEqual(require.resolve(legacyEntrypointRoot), require.resolve('@datadog/flagging-core/rules-based'))
assert.strictEqual(require(legacyEntrypointRoot), require('@datadog/flagging-core/rules-based'))

for (const [field, condition] of [
  ['main', 'require'],
  ['module', 'import'],
  ['types', 'types'],
]) {
  const target = path.resolve(legacyEntrypointRoot, legacyEntrypoint[field])
  assert.strictEqual(target, path.resolve(packageRoot, packageJson.exports['./rules-based'][condition]))
  assert.ok(fs.statSync(target).isFile(), `Missing packed ${field} entrypoint: ${target}`)
}

console.log('Packed rules-based entrypoint supports physical directory resolution')
