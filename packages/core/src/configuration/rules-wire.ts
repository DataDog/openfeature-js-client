import type { FlagsConfiguration } from './configuration'
import { decodeUniversalFlagConfiguration, decodeUniversalFlagConfigurationBinary } from './ufc-protobuf'
import {
  decodeSafely,
  type FlagsConfigurationWire,
  INVALID_CONFIGURATION_WIRE_ERROR,
  parseConfigurationWire,
  type SerializedConfiguration,
} from './wire-types'
import { isWireEntry } from './wire-validation'

/**
 * Parse the rules entry from an opaque flags configuration wire value.
 */
export function configurationFromRulesString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  return serialized ? rulesConfigurationFromWire(serialized) : { configurationError: INVALID_CONFIGURATION_WIRE_ERROR }
}

/**
 * Decode a binary Universal Flag Configuration response.
 */
export function configurationFromRulesBinary(response: Uint8Array): FlagsConfiguration {
  return {
    rules: {
      response: decodeUniversalFlagConfigurationBinary(response),
    },
  }
}

export function rulesConfigurationFromWire(serialized: SerializedConfiguration): FlagsConfiguration {
  if (serialized.rules === undefined) return {}
  if (!isWireEntry(serialized.rules)) return { rulesError: 'Invalid rules configuration wire entry' }

  const { rules } = serialized
  const response = decodeSafely(() => decodeUniversalFlagConfiguration(rules.response))
  if (!response) return { rulesError: 'Rules configuration response could not be decoded' }

  return {
    rules: {
      ...rules,
      response,
    },
  }
}
