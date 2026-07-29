globalThis.TextEncoder = undefined
globalThis.TextDecoder = undefined
globalThis.BigInt = undefined

const { evaluateRulesBasedConfiguration } = require('@datadog/flagging-core')
const { configurationFromString, configurationToString } = require('@datadog/flagging-core/configuration')

const configuration = configurationFromString(
  JSON.stringify({
    version: 1,
    rules: {
      response: 'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADKgJvbg==',
    },
  })
)
const roundTrippedConfiguration = configurationFromString(configurationToString(configuration))
const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
const result = evaluateRulesBasedConfiguration(
  roundTrippedConfiguration.rules?.response,
  'boolean',
  'browser-flag',
  false,
  {},
  logger
)

if (result.value !== true || result.variant !== 'on' || result.reason !== 'STATIC') {
  throw new Error(`Unexpected React Native smoke-test result: ${JSON.stringify(result)}`)
}

console.log('React Native Metro smoke test passed')
