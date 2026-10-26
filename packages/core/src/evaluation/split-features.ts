import type { FlagMetadata, Logger } from '@openfeature/core'

export const FEATURE_DESTINATION_HOOK = 'HOOK'
export const FEATURE_DESTINATION_EXPOSURE = 'EXPOSURE'
export const FEATURE_DESTINATION_EVALUATION = 'EVALUATION'

/**
 * Flag-metadata prefixes, one per destination. Only `__dd_feature.` is a public
 * contract; the other two carry features to the SDK's own exposure and
 * flag-evaluation paths.
 */
export const METADATA_FEATURE_PREFIX = '__dd_feature.'
export const METADATA_EXPOSURE_FEATURE_PREFIX = '__dd_exposure_feature.'
export const METADATA_EVALUATION_FEATURE_PREFIX = '__dd_evaluation_feature.'

/**
 * Present only when the selected split routes a feature to EVALUATION, so
 * evaluation-count consumers can skip scanning the metadata otherwise.
 */
export const HAS_EVALUATION_FEATURES_METADATA_KEY = '__dd_has_evaluation_features'

export type FeatureValue = string | number | boolean

// Cap the set of warned unknown destinations so a hostile configuration cannot
// spam the log; matches the other Datadog SDKs.
const MAX_WARNED_DESTINATIONS = 64
const warnedDestinations = new Set<string>()

function metadataPrefix(destination: string): string | undefined {
  switch (destination) {
    case FEATURE_DESTINATION_HOOK:
      return METADATA_FEATURE_PREFIX
    case FEATURE_DESTINATION_EXPOSURE:
      return METADATA_EXPOSURE_FEATURE_PREFIX
    case FEATURE_DESTINATION_EVALUATION:
      return METADATA_EVALUATION_FEATURE_PREFIX
    default:
      return undefined
  }
}

function warnUnknownDestination(destination: string, logger: Logger): void {
  if (warnedDestinations.has(destination) || warnedDestinations.size >= MAX_WARNED_DESTINATIONS) return
  warnedDestinations.add(destination)
  logger.warn(`Ignoring unknown feature destination ${destination}`)
}

/**
 * Keep non-empty string destinations only; a feature without any goes nowhere,
 * so it is treated as absent and does not claim its key against later entries.
 */
function readDestinations(destinations: unknown): string[] | undefined {
  if (!Array.isArray(destinations)) return undefined
  const list = destinations.filter(
    (destination): destination is string => typeof destination === 'string' && destination !== ''
  )
  return list.length > 0 ? list : undefined
}

function isFeatureValue(value: unknown): value is FeatureValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface SplitFeatureMetadata {
  /** Metadata entries, `prefix + key` to the feature value. */
  entries: Record<string, FeatureValue>
  hasEvaluationFeatures: boolean
}

/**
 * Turn the selected split's `features` into flag-metadata entries, one per
 * (feature, destination). Parsing is lenient: a missing or malformed `features`
 * field yields no entries and never fails the flag, and a feature with an
 * unsupported value type is skipped. On a repeated key the first valid feature
 * wins for every destination.
 */
export function createSplitFeatureMetadata(features: unknown, logger: Logger): SplitFeatureMetadata {
  const result: SplitFeatureMetadata = { entries: {}, hasEvaluationFeatures: false }
  if (!Array.isArray(features)) return result

  const seenKeys = new Set<string>()
  for (const item of features) {
    if (!isRecord(item)) continue
    const { key, value, destinations } = item
    if (typeof key !== 'string' || key === '' || !isFeatureValue(value)) continue
    const knownDestinations = readDestinations(destinations)
    if (knownDestinations === undefined) continue
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    for (const destination of knownDestinations) {
      const prefix = metadataPrefix(destination)
      if (prefix === undefined) {
        warnUnknownDestination(destination, logger)
        continue
      }
      result.entries[`${prefix}${key}`] = value
      if (prefix === METADATA_EVALUATION_FEATURE_PREFIX) result.hasEvaluationFeatures = true
    }
  }
  return result
}

/**
 * Read the features stored in flag metadata under `prefix`, keyed without the
 * prefix. Returns undefined when there are none, so callers can omit the field.
 */
export function featuresWithPrefix(
  metadata: FlagMetadata | undefined,
  prefix: string
): Record<string, FeatureValue> | undefined {
  if (metadata == null) return undefined
  let features: Record<string, FeatureValue> | undefined
  for (const [metadataKey, value] of Object.entries(metadata)) {
    if (!metadataKey.startsWith(prefix) || !isFeatureValue(value)) continue
    features ??= {}
    features[metadataKey.slice(prefix.length)] = value
  }
  return features
}
