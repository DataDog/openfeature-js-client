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

const loadedProtobufModules = Object.keys(require.cache).filter((path) => path.includes('@bufbuild/protobuf'))
if (loadedProtobufModules.length > 0) {
  throw new Error(`Default entry point loaded protobuf modules:\n${loadedProtobufModules.join('\n')}`)
}

console.log('Root entry point does not load protobuf')
