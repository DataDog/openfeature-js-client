import { configurationFromString, configurationToString, getClientFingerprint } from '@datadog/openfeature-browser'
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
const serialized = configurationToString(configuration)
const roundTripWire = JSON.parse(serialized) as Record<string, unknown>
const restored = configurationFromString(serialized)
const flag = configuration.precomputed?.response.data.attributes.flags['precomputed-flag']
const restoredFlag = restored.precomputed?.response.data.attributes.flags['precomputed-flag']

const fingerprint = getClientFingerprint()
const forwarded = JSON.parse(JSON.stringify({ clientFingerprint: fingerprint }))
assert(typeof fingerprint === 'string' && fingerprint.length > 0, 'root entrypoint did not expose a client fingerprint')
assert(forwarded.clientFingerprint === fingerprint, 'fingerprint did not survive application transport')

assert(flag?.variationValue === true, 'precomputed flag was not parsed')
assert(configuration.rules === undefined, 'precomputed entrypoint parsed rules')
assert(roundTripWire.rules === undefined, 'precomputed entrypoint serialized rules')
assert(restoredFlag?.variationValue === true, 'precomputed flag did not survive a round trip')

reportSuccess({
  entrypoint: 'precomputed',
  booleanValue: restoredFlag.variationValue,
  rulesExcluded: true,
})
