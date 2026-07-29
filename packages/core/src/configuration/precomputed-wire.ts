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
