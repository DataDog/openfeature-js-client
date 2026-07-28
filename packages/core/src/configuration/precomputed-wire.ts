import type { FlagsConfiguration, PrecomputedConfigurationResponse } from './configuration'
import {
  decodeSafely,
  type FlagsConfigurationWire,
  parseConfigurationWire,
  type SerializedConfiguration,
} from './wire-types'
import { isPrecomputedConfigurationResponse, isPrecomputedWireEntry } from './wire-validation'

/**
 * Parse the precomputed entry from an opaque flags configuration wire value.
 */
export function configurationFromPrecomputedString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  return serialized ? precomputedConfigurationFromWire(serialized) : {}
}

export function precomputedConfigurationFromWire(serialized: SerializedConfiguration): FlagsConfiguration {
  if (!isPrecomputedWireEntry(serialized.precomputed)) return {}

  const { precomputed } = serialized
  const response = decodeSafely(() => JSON.parse(precomputed.response) as PrecomputedConfigurationResponse)
  if (!response || !isPrecomputedConfigurationResponse(response)) return {}

  return {
    precomputed: {
      ...precomputed,
      response,
    },
  }
}

/**
 * Serialize a precomputed configuration to a string that can be deserialized
 * with `configurationFromPrecomputedString`.
 *
 * @throws If the configuration contains rules.
 */
export function configurationToString(configuration: FlagsConfiguration): FlagsConfigurationWire {
  if (configuration.rules) {
    throw new Error('Rules configurations cannot be serialized to the wire format')
  }

  const wire: SerializedConfiguration = {
    version: 1,
  }

  if (configuration.precomputed) {
    wire.precomputed = {
      ...configuration.precomputed,
      response: JSON.stringify(configuration.precomputed.response),
    }
  }
  return JSON.stringify(wire)
}
