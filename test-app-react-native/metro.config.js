const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

const mode = process.env.CORE_SMOKE_MODE || 'modern'

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    unstable_enablePackageExports: mode === 'modern',
    unstable_conditionNames: ['react-native', 'browser', 'require', 'default'],
    ...(mode === 'legacy-esm' ? { resolverMainFields: ['react-native', 'browser', 'module', 'main'] } : {}),
  },
})
