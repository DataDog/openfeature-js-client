const { getDefaultConfig } = require('expo/metro-config')

const mode = process.env.EXPO_PUBLIC_CORE_RESOLUTION || 'legacy-cjs'
if (!['modern', 'legacy-cjs', 'legacy-esm'].includes(mode)) {
  throw new Error(`Unknown CORE_RESOLUTION mode: ${mode}`)
}

const config = getDefaultConfig(__dirname)
config.resolver.unstable_enablePackageExports = mode === 'modern'
if (mode !== 'modern') {
  config.resolver.resolverMainFields =
    mode === 'legacy-esm' ? ['react-native', 'browser', 'module', 'main'] : ['react-native', 'browser', 'main']
}

// Show the actual resolved files, not just the requested mode. Delegate to Expo's
// resolver so this does not alias packages or bypass normal Metro resolution.
const upstreamResolve = config.resolver.resolveRequest
const logged = new Set()
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = upstreamResolve
    ? upstreamResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform)
  if (moduleName === '@datadog/flagging-core' || moduleName === '@datadog/flagging-core/rules-based') {
    const message = `[${mode}/${platform}] ${moduleName} -> ${result.filePath}`
    if (!logged.has(message)) {
      logged.add(message)
      console.log(message)
      if (mode === 'modern' && result.filePath?.includes('/bundle/legacy/')) {
        console.log('Note: Metro selected the physical legacy entrypoint even with package exports enabled.')
      }
    }
  }
  return result
}

module.exports = config
