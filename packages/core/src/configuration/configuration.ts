import type { EvaluationContext, FlagValueType, JsonValue, ResolutionReason } from '@openfeature/core'

/**
 * Internal flags configuration for DatadogProvider.
 */
export type FlagsConfiguration = {
  /** @internal */
  precomputed?: PrecomputedConfiguration
}

/** @internal */
export type PrecomputedConfiguration = {
  response: PrecomputedConfigurationResponse
  context?: EvaluationContext
  fetchedAt?: UnixTimestamp
}

// Fancy way to map FlagValueType to expected FlagValue.
/** @internal */
export type FlagTypeToValue<T extends FlagValueType> = {
  boolean: boolean
  string: string
  number: number
  object: JsonValue
}[T]

/** @internal
 * Timestamp in milliseconds since Unix Epoch.
 */
export type UnixTimestamp = number

/** @internal */
export type PrecomputedConfigurationResponse = {
  data: {
    attributes: {
      /** When configuration was generated. */
      createdAt: string
      flags: Record<string, PrecomputedFlag>
    }
  }
}

/** @internal
 * Generic passthrough metadata from the FFE backend (e.g. version,
 * lastModified). Values are restricted to the primitive types that
 * OpenFeature's FlagMetadata spec allows (string | number | boolean).
 */
export type FlagMetadata = Record<string, string | number | boolean>

/** @internal */
export type PrecomputedFlag<T extends FlagValueType = FlagValueType> = {
  allocationKey: string
  variationKey: string
  variationType: T
  variationValue: FlagTypeToValue<T>
  reason: ResolutionReason
  doLog: boolean
  extraLogging: Record<string, unknown>
  /** @internal Backend-emitted metadata. Surfaced in flagMetadata. */
  metadata?: FlagMetadata
}

/** @internal
 * SDK-internal keys (allocationKey, variationType, doLog) take precedence on
 * collision with backend metadata. The intersection widens to FlagMetadata so
 * passthrough keys like `version` survive end-to-end.
 */
export type PrecomputedFlagMetadata = {
  allocationKey: string
  variationType: FlagValueType
  doLog: boolean
} & FlagMetadata
