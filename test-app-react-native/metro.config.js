const assert = require('node:assert/strict')
const path = require('node:path')
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const mode = process.env.CORE_SMOKE_MODE || 'modern'
if (!['modern', 'legacy-cjs', 'legacy-esm'].includes(mode)) {
  throw new Error(`Unknown CORE_SMOKE_MODE: ${mode}`)
}

const format = mode === 'legacy-esm' ? 'esm' : 'cjs'
const packageRoot = path.join(__dirname, 'node_modules/@datadog/flagging-core')
const expectedPaths = new Map([
  ['@datadog/flagging-core', path.join(packageRoot, format, 'index.js')],
  // This Metro fixture selects the physical legacy parser even with package exports enabled.
  ['@datadog/flagging-core/rules-based', path.join(packageRoot, 'bundle/legacy', format, 'rules-based.js')],
])

const config = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    unstable_enablePackageExports: mode === 'modern',
    unstable_conditionNames: ['react-native', 'browser', 'require', 'default'],
    ...(mode === 'legacy-esm' ? { resolverMainFields: ['react-native', 'browser', 'module', 'main'] } : {}),
  },
})

// Assert the actual result without aliasing packages or bypassing Metro's resolver.
const upstreamResolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = upstreamResolve
    ? upstreamResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
  if (expectedPaths.has(moduleName)) {
    const message = `Unexpected ${moduleName} resolution in ${mode}/${platform}`
    assert.equal(result.type, 'sourceFile', message)
    assert.equal(result.filePath, expectedPaths.get(moduleName), message)
    console.log(`[${mode}/${platform}] ${moduleName} -> ${result.filePath}`)
  }
  return result
}

module.exports = config
