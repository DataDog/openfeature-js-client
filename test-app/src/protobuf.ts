import { evaluateRulesBasedConfiguration, matchesRule, OperatorType } from '@datadog/flagging-core'
import { configurationFromString, configurationToString, DatadogProvider } from '@datadog/openfeature-browser'
import { assert, reportSuccess } from './smoke'

const protobufRulesResponse =
  'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADGigKDGludGVnZXItZmxhZxIYEAIaAhgqIhAKCmFsbG9jYXRpb24iAiADKgJvbg=='
const precomputedResponse = {
  data: {
    attributes: {
      createdAt: '2026-07-06T23:01:56.822Z',
      flags: {
        'provider-flag': {
          allocationKey: 'allocation',
          variationKey: 'on',
          variationType: 'BOOLEAN',
          variationValue: true,
          reason: 'STATIC',
          doLog: false,
        },
      },
    },
  },
}
const configuration = configurationFromString(
  JSON.stringify({
    version: 1,
    precomputed: { response: JSON.stringify(precomputedResponse) },
    rules: { response: protobufRulesResponse },
  })
)

assert(configuration.rules, 'protobuf rules configuration was not decoded')
assert(
  configuration.rules.response.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration',
  'rules response is not a generated protobuf message'
)

const context = { targetingKey: 'browser-user' }
const booleanDetails = evaluateRulesBasedConfiguration(
  configuration.rules.response,
  'boolean',
  'browser-flag',
  false,
  context,
  console
)
const integerDetails = evaluateRulesBasedConfiguration(
  configuration.rules.response,
  'number',
  'integer-flag',
  0,
  context,
  console
)
const provider = new DatadogProvider({
  clientToken: 'test-token',
  site: 'datadoghq.com',
  env: 'test',
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
  initialFlagsConfiguration: configuration,
})
const providerDetails = provider.resolveBooleanEvaluation('provider-flag', false, context, console)
const restored = configurationFromString(configurationToString(configuration))
const sha256Matched = matchesRule(
  {
    conditions: [
      {
        attribute: 'name',
        operator: OperatorType.ONE_OF_SHA256,
        value: {
          salt: [1, 2],
          hashes: ['c0e551d80aa1e2cb1eaf5be7edbb04e51eb1823e562e2ce5dfeda0ecba76c744'],
        },
      },
    ],
  },
  { name: 'hello' }
)

assert(booleanDetails.value === true, 'protobuf boolean evaluation returned the wrong value')
assert(integerDetails.value === 42, 'protobuf int64 evaluation returned the wrong value')
assert(providerDetails.value === true, 'DatadogProvider did not evaluate the decoded configuration')
assert(
  restored.rules?.response.$typeName === 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration',
  'protobuf rules configuration did not survive a round trip'
)
assert(sha256Matched, 'SHA-256 condition did not match')

reportSuccess({
  entrypoint: 'protobuf',
  protobufTypeName: configuration.rules.response.$typeName,
  booleanValue: booleanDetails.value,
  integerValue: integerDetails.value,
  providerValue: providerDetails.value,
  sha256Matched,
})
