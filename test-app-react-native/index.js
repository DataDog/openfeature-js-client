globalThis.TextEncoder = undefined
globalThis.TextDecoder = undefined
globalThis.BigInt = undefined

const { evaluate, evaluateRulesBasedConfiguration } = require('@datadog/flagging-core')
const { configurationFromString, configurationToString } = require('@datadog/flagging-core/rules-based')
const { rules, precomputed } = require('./configurations')

const configuration = configurationFromString(JSON.stringify(rules))
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
const integerResult = evaluateRulesBasedConfiguration(
  roundTrippedConfiguration.rules?.response,
  'number',
  'integer-flag',
  0,
  {},
  logger
)

if (result.value !== true || result.variant !== 'on' || result.reason !== 'STATIC') {
  throw new Error(`Unexpected React Native smoke-test result: ${JSON.stringify(result)}`)
}
if (integerResult.value !== 42 || integerResult.reason !== 'STATIC') {
  throw new Error(`Unexpected React Native integer smoke-test result: ${JSON.stringify(integerResult)}`)
}

const precomputedConfiguration = configurationFromString(JSON.stringify(precomputed))
const staticResult = evaluate(
  precomputedConfiguration,
  'boolean',
  'precomputed-flag',
  false,
  precomputed.precomputed.context,
  logger
)
const mismatchResult = evaluate(precomputedConfiguration, 'boolean', 'precomputed-flag', false, {}, logger)
if (staticResult.value !== true || staticResult.reason !== 'STATIC' || mismatchResult.errorCode !== 'INVALID_CONTEXT') {
  throw new Error('Unexpected React Native precomputed evaluation results')
}

const mixedConfiguration = configurationFromString(JSON.stringify({ ...rules, precomputed: precomputed.precomputed }))
const fallbackResult = evaluate(mixedConfiguration, 'boolean', 'browser-flag', false, {}, logger)
if (fallbackResult.value !== true || fallbackResult.reason !== 'STATIC') {
  throw new Error(`Unexpected React Native rules fallback result: ${JSON.stringify(fallbackResult)}`)
}

console.log('React Native Metro smoke test passed (rules, precomputed, and mixed configurations)')
