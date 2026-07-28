require('@datadog/flagging-core')

const loadedProtobufModules = Object.keys(require.cache).filter((path) => path.includes('@bufbuild/protobuf'))
if (loadedProtobufModules.length > 0) {
  throw new Error(`Default entry point loaded protobuf modules:\n${loadedProtobufModules.join('\n')}`)
}

console.log('Default entry point does not load protobuf')
