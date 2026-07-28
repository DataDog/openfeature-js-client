import type { FlagsConfiguration } from './configuration'
import { precomputedConfigurationFromWire } from './precomputed-wire'
import { rulesConfigurationFromWire } from './rules-wire'
import { type FlagsConfigurationWire, parseConfigurationWire } from './wire-types'

export { configurationToString } from './precomputed-wire'
export type { FlagsConfigurationWire } from './wire-types'

/**
 * Parse an opaque flags configuration wire value.
 */
export function configurationFromString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  if (!serialized) return {}
  return {
    ...precomputedConfigurationFromWire(serialized),
    ...rulesConfigurationFromWire(serialized),
  }
}
