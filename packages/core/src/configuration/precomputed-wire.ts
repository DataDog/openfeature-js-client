import type { FlagsConfiguration } from './configuration'
import {
  decodeSafely,
  type FlagsConfigurationWire,
  parseConfigurationWire,
  type SerializedConfiguration,
} from './wire-types'
import { isPrecomputedWireEntry, parsePrecomputedConfigurationResponse } from './wire-validation'

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
  const parsed = decodeSafely(() => parsePrecomputedConfigurationResponse(JSON.parse(precomputed.response)))
  if (!parsed) return {}

  return {
    precomputed: {
      ...precomputed,
      ...parsed,
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
    const { context, response, fetchedAt, etag } = configuration.precomputed
    wire.precomputed = {
      context,
      response: JSON.stringify(response),
      fetchedAt,
      etag,
    }
  }
  return JSON.stringify(wire)
}
