require('@datadog/flagging-core')
const { configurationFromString } = require('@datadog/flagging-core/precomputed')

const configuration = configurationFromString(JSON.stringify({ version: 1, rules: { response: 'ignored' } }))
if (Object.keys(configuration).length > 0) {
  throw new Error(`Precomputed entry point parsed unsupported capabilities: ${JSON.stringify(configuration)}`)
}

const loadedProtobufModules = Object.keys(require.cache).filter((path) => path.includes('@bufbuild/protobuf'))
if (loadedProtobufModules.length > 0) {
  throw new Error(`Default entry point loaded protobuf modules:\n${loadedProtobufModules.join('\n')}`)
}

console.log('Default and precomputed entry points do not load protobuf')
