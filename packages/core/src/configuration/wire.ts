import type { FlagsConfiguration } from './configuration'
import { precomputedConfigurationFromWire, precomputedConfigurationToWire } from './precomputed-wire'
import { rulesConfigurationFromWire } from './rules-wire'
import { encodeUniversalFlagConfiguration } from './ufc-protobuf'
import {
  type FlagsConfigurationWire,
  INVALID_CONFIGURATION_WIRE_ERROR,
  parseConfigurationWire,
  type SerializedConfiguration,
} from './wire-types'

export type { FlagsConfigurationWire } from './wire-types'

/**
 * Parse an opaque flags configuration wire value.
 */
export function configurationFromString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  if (!serialized) return { configurationError: INVALID_CONFIGURATION_WIRE_ERROR }
  return {
    ...precomputedConfigurationFromWire(serialized),
    ...rulesConfigurationFromWire(serialized),
  }
}

/**
 * Serialize a flags configuration to a string that can be deserialized with
 * `configurationFromString`.
 */
export function configurationToString(configuration: FlagsConfiguration): FlagsConfigurationWire {
  const wire: SerializedConfiguration = precomputedConfigurationToWire(configuration)

  if (configuration.rules) {
    const { response, fetchedAt, etag } = configuration.rules
    wire.rules = {
      response: encodeUniversalFlagConfiguration(response),
      fetchedAt,
      etag,
    }
  }

  return JSON.stringify(wire)
}
