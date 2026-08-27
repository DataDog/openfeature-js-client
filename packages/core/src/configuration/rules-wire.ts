import { base64Decode } from '@bufbuild/protobuf/wire'
import type { FlagsConfiguration } from './configuration'
import { decodeFlagsConfiguration } from './ufc-protobuf'
import {
  type ConfigurationWireContents,
  decodeSafely,
  type FlagsConfigurationWire,
  INVALID_CONFIGURATION_WIRE_ERROR,
  parseConfigurationWire,
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
 * Decode a binary flags configuration response.
 */
export function configurationFromRulesBinary(response: Uint8Array): FlagsConfiguration {
  return {
    rules: {
      response: decodeFlagsConfiguration(response),
    },
  }
}

export function rulesConfigurationFromWire(serialized: ConfigurationWireContents): FlagsConfiguration {
  if (serialized.rules === undefined) return {}
  if (!isWireEntry(serialized.rules)) return { rulesError: 'Invalid rules configuration wire entry' }

  const { rules } = serialized
  const response = decodeSafely(() => decodeFlagsConfiguration(base64Decode(rules.response)))
  if (!response) return { rulesError: 'Rules configuration response could not be decoded' }

  return {
    rules: {
      ...rules,
      response,
    },
  }
}
