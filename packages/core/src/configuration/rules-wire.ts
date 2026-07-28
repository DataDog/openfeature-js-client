import type { FlagsConfiguration } from './configuration'
import { decodeUniversalFlagConfiguration } from './ufc-protobuf'
import {
  decodeSafely,
  type FlagsConfigurationWire,
  parseConfigurationWire,
  type SerializedConfiguration,
} from './wire-types'
import { isWireEntry } from './wire-validation'

/**
 * Parse the rules entry from an opaque flags configuration wire value.
 */
export function configurationFromRulesString(wire: FlagsConfigurationWire): FlagsConfiguration {
  const serialized = parseConfigurationWire(wire)
  return serialized ? rulesConfigurationFromWire(serialized) : {}
}

export function rulesConfigurationFromWire(serialized: SerializedConfiguration): FlagsConfiguration {
  if (!isWireEntry(serialized.rules)) return {}

  const { rules } = serialized
  const response = decodeSafely(() => decodeUniversalFlagConfiguration(rules.response))
  if (!response) return {}

  return {
    rules: {
      ...rules,
      response,
    },
  }
}
