import type { EvaluationContext } from '@openfeature/core'
import type { TimeStamp } from '../time'

export type FlagsConfigurationWire = string

export type SerializedConfiguration = {
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

export function parseConfigurationWire(wire: FlagsConfigurationWire): SerializedConfiguration | undefined {
  let serialized: unknown
  try {
    serialized = JSON.parse(wire)
  } catch {
    return undefined
  }
  if (typeof serialized !== 'object' || serialized === null || !('version' in serialized) || serialized.version !== 1) {
    return undefined
  }
  return serialized as SerializedConfiguration
}

export function decodeSafely<T>(decode: () => T): T | undefined {
  try {
    return decode()
  } catch {
    return undefined
  }
}
