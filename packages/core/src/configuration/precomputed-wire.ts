import type { FlagsConfiguration } from './configuration'
import {
  type ConfigurationWireContents,
  decodeSafely,
  type FlagsConfigurationWire,
  INVALID_CONFIGURATION_WIRE_ERROR,
  parseConfigurationWire,
} from './wire-types'
import { isPrecomputedWireEntry, parsePrecomputedConfigurationResponse } from './wire-validation'

/**
 * Parse the precomputed entry from an opaque flags configuration wire value.
 */
export function configurationFromPrecomputedString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  return serialized
    ? precomputedConfigurationFromWire(serialized)
    : { configurationError: INVALID_CONFIGURATION_WIRE_ERROR }
}

/**
 * Serialize only the precomputed capability of a flags configuration.
 */
export function configurationToPrecomputedString(configuration: FlagsConfiguration): FlagsConfigurationWire {
  return JSON.stringify(precomputedConfigurationToWire(configuration))
}

export function precomputedConfigurationFromWire(serialized: ConfigurationWireContents): FlagsConfiguration {
  if (serialized.precomputed === undefined) return {}
  if (!isPrecomputedWireEntry(serialized.precomputed)) {
    return { precomputedError: 'Invalid precomputed configuration wire entry' }
  }

  const { precomputed } = serialized
  const parsed = decodeSafely(() => parsePrecomputedConfigurationResponse(JSON.parse(precomputed.response)))
  if (!parsed) return { precomputedError: 'Precomputed configuration response is not valid JSON' }
  if ('error' in parsed) return { precomputedError: parsed.error }

  return {
    precomputed: {
      ...precomputed,
      ...parsed,
    },
  }
}

export function precomputedConfigurationToWire(configuration: FlagsConfiguration): ConfigurationWireContents {
  const wire: ConfigurationWireContents = { version: 1 }
  if (!configuration.precomputed) return wire

  const { context, response, fetchedAt, etag } = configuration.precomputed
  wire.precomputed = {
    context,
    response: JSON.stringify(response),
    fetchedAt,
    etag,
  }
  return wire
}
