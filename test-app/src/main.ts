import { evaluateRulesBasedConfiguration, matchesRule, OperatorType } from '@datadog/flagging-core'
import { configurationFromString, configurationToString } from '@datadog/openfeature-browser'
import { assert, reportSuccess } from './smoke'

const rulesResponse =
  'EgRwcm9kGigKDGJyb3dzZXItZmxhZxIYEAQaAigBIhAKCmFsbG9jYXRpb24iAiADGigKDGludGVnZXItZmxhZxIYEAIaAhgqIhAKCmFsbG9jYXRpb24iAiADKgJvbg=='
const configuration = configurationFromString(JSON.stringify({ version: 1, rules: { response: rulesResponse } }))

assert(configuration.rules, 'rules configuration was not parsed')

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

assert(booleanDetails.value === true, 'boolean rule evaluation returned the wrong value')
assert(integerDetails.value === 42, 'integer rule evaluation returned the wrong value')
assert(restored.rules?.response.flags['browser-flag'], 'rules configuration did not survive a round trip')
assert(sha256Matched, 'SHA-256 condition did not match')

reportSuccess({
  entrypoint: 'full',
  booleanValue: booleanDetails.value,
  integerValue: integerDetails.value,
  sha256Matched,
})
