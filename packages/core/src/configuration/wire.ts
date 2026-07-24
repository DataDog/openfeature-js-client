import type { EvaluationContext } from '@openfeature/core'
import type { TimeStamp } from '../time'
import type { FlagsConfiguration, PrecomputedConfigurationResponse } from './configuration'
import { decodeUniversalFlagConfiguration } from './ufc-protobuf'
import { isPrecomputedConfigurationResponse, isPrecomputedWireEntry, isWireEntry } from './wire-validation'

export type FlagsConfigurationWire = string

type SerializedConfiguration = {
  version: 1
  precomputed?: {
    context?: EvaluationContext
    response: string
    fetchedAt?: TimeStamp
    etag?: string
  }
  rules?: {
    response: string
    fetchedAt?: TimeStamp
    etag?: string
  }
}

/**
 * Parse an opaque flags configuration wire value.
 */
export function configurationFromString(wire: FlagsConfigurationWire): FlagsConfiguration {
  let serialized: SerializedConfiguration
  try {
    serialized = JSON.parse(wire)
  } catch {
    return {}
  }
  if (typeof serialized !== 'object' || serialized === null || serialized.version !== 1) {
    return {}
  }

  const configuration: FlagsConfiguration = {}
  if (isPrecomputedWireEntry(serialized.precomputed)) {
    const { precomputed } = serialized
    const response = decodeSafely(() => JSON.parse(precomputed.response) as PrecomputedConfigurationResponse)
    if (response && isPrecomputedConfigurationResponse(response)) {
      configuration.precomputed = {
        ...precomputed,
        response,
      }
    }
  }
  if (isWireEntry(serialized.rules)) {
    const { rules } = serialized
    const response = decodeSafely(() => decodeUniversalFlagConfiguration(rules.response))
    if (response) {
      configuration.rules = {
        ...rules,
        response,
      }
    }
  }
  return configuration
}

/**
 * Serialize a precomputed configuration to a string that can be deserialized
 * with `configurationFromString`. Rules configurations cannot be serialized
 * because their wire representation is the original protobuf payload.
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

function decodeSafely<T>(decode: () => T): T | undefined {
  try {
    return decode()
  } catch {
    return undefined
  }
}
