import { configurationFromString, configurationToString } from '@datadog/openfeature-browser/precomputed'
import { assert, reportSuccess } from './smoke'

const response = {
  data: {
    attributes: {
      createdAt: '2026-07-06T23:01:56.822Z',
      flags: {
        'precomputed-flag': {
          allocationKey: 'allocation',
          variationKey: 'on',
          variationType: 'BOOLEAN',
          variationValue: true,
          reason: 'STATIC',
          doLog: true,
        },
      },
    },
  },
}
const configuration = configurationFromString(
  JSON.stringify({
    version: 1,
    precomputed: { response: JSON.stringify(response) },
    rules: { response: 'ignored by the precomputed entrypoint' },
  })
)
const roundTrip = JSON.parse(configurationToString(configuration)) as Record<string, unknown>
const flag = configuration.precomputed?.response.data.attributes.flags['precomputed-flag']

assert(flag?.variationValue === true, 'precomputed flag was not parsed')
assert(configuration.rules === undefined, 'precomputed entrypoint parsed rules')
assert(roundTrip.rules === undefined, 'precomputed entrypoint serialized rules')

reportSuccess({
  entrypoint: 'precomputed',
  booleanValue: flag.variationValue,
  rulesExcluded: true,
})
