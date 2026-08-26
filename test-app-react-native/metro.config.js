const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ['react-native', 'browser', 'require', 'default'],
  },
})
