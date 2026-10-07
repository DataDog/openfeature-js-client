const {
  configurationFromString: configurationFromRootString,
  configurationToString: configurationToRootString,
} = require('@datadog/flagging-core')

const configuration = configurationFromRootString(JSON.stringify({ version: 1, rules: { response: 'ignored' } }))
if (Object.keys(configuration).length > 0) {
  throw new Error(`Default entry point parsed unsupported capabilities: ${JSON.stringify(configuration)}`)
}

const rootConfiguration = configurationFromRootString(
  JSON.stringify({
    version: 1,
    precomputed: {
      response: JSON.stringify({ data: { attributes: { createdAt: 0, flags: {} } } }),
    },
    rules: { response: 'ignored' },
  })
)
const restoredRootConfiguration = configurationFromRootString(configurationToRootString(rootConfiguration))
if (!restoredRootConfiguration.precomputed || restoredRootConfiguration.rules) {
  throw new Error('Root parser did not preserve precomputed-only behavior')
}

const loadedHeavyModules = Object.keys(require.cache).filter((filename) => {
  const normalized = filename.replace(/\\/g, '/')
  return normalized.includes('@bufbuild/protobuf') || normalized.includes('/bundle/legacy/')
})
if (loadedHeavyModules.length > 0) {
  throw new Error(`Default entry point loaded protobuf or compatibility bundles:\n${loadedHeavyModules.join('\n')}`)
}

console.log('Root entry point does not load protobuf or compatibility bundles')
