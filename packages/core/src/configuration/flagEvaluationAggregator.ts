import type {
  EvaluationContext,
  EvaluationContextValue,
  EvaluationDetails,
  FlagMetadata,
  FlagValue,
} from '@openfeature/core'
import {
  type FeatureValue,
  featuresWithPrefix,
  HAS_EVALUATION_FEATURES_METADATA_KEY,
  METADATA_EVALUATION_FEATURE_PREFIX,
} from '../evaluation/split-features'
import { getMD5Hash } from '../obfuscation'
import { type TimeStamp, timeStampNow } from '../time'
import { captureEvaluationContext, sanitizeEvaluationError } from './evaluation-privacy'
import { createFlagEvaluationEvent } from './flagEvaluationEvent'
import type { FlagEvaluationEvent } from './flagEvaluationEvent.types'

const EVALUATION_TIMESTAMP_METADATA_KEY = '__dd_eval_timestamp_ms'
const ENVIRONMENT_ID_METADATA_KEY = '__dd_environment_id'
const ENVIRONMENT_NAME_METADATA_KEY = '__dd_environment_name'

type EnvironmentIdentity = {
  id?: string
  name: string
}

interface FlagEvaluationAggregationData {
  environment?: EnvironmentIdentity
  flagKey: string
  variantKey?: string
  allocationKey?: string
  targetingRuleKey?: string
  targetingKey?: string
  targetingContext?: Record<string, EvaluationContextValue>
  features?: Record<string, FeatureValue>
  count: number
  firstEvaluation: TimeStamp
  lastEvaluation: TimeStamp
  runtimeDefaultUsed: boolean
  error?: string
}

export interface AggregationDiagnostic {
  type: 'add' | 'flush'
  aggregationId: string
  aggregationSize: number
  data: Readonly<FlagEvaluationAggregationData>
  event?: FlagEvaluationEvent
  trigger?: string
}

export class FlagEvaluationAggregator {
  private aggregatedData = new Map<string, FlagEvaluationAggregationData>()
  private generation = 0
  private intervalId?: NodeJS.Timeout
  private readonly flushInterval: number
  private readonly onFlush: (events: FlagEvaluationEvent[]) => void

  constructor(
    flushInterval: number,
    onFlush: (events: FlagEvaluationEvent[]) => void,
    private readonly observe?: (diagnostic: AggregationDiagnostic) => void
  ) {
    this.flushInterval = flushInterval
    this.onFlush = onFlush
  }

  start(): void {
    this.intervalId = setInterval(() => {
      this.flush('interval')
    }, this.flushInterval)
  }

  stop(trigger = 'shutdown'): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.flush(trigger)
  }

  addEvaluation<T extends FlagValue>(context: EvaluationContext, details: EvaluationDetails<T>, error?: string): void {
    const observeFullData = details.flagMetadata?.__dd_observe_full_evaluation_data === true
    const capturedContext = captureEvaluationContext(context, observeFullData)
    const sanitizedError = sanitizeEvaluationError(
      error ?? details.errorCode ?? (details.reason === 'ERROR' ? 'GENERAL' : undefined)
    )
    const identity = {
      environment: readEnvironmentIdentity(details.flagMetadata),
      flagKey: details.flagKey,
      variantKey: details.variant,
      allocationKey: details.flagMetadata?.allocationKey as string | undefined,
      targetingRuleKey: details.flagMetadata?.targetingRuleKey as string | undefined,
      ...capturedContext,
      features: canonicalEvaluationFeatures(details.flagMetadata),
      error: sanitizedError,
    }
    // Consent keeps protected and full-data evaluations in separate buckets even
    // when their visible fields happen to match (for example, an empty key).
    const keyString = `${observeFullData}:${getMD5Hash(JSON.stringify(identity))}`
    const timestamp = getEvaluationTimestamp(details)

    const existingData = this.aggregatedData.get(keyString)
    if (existingData) {
      existingData.count++
      existingData.lastEvaluation = timestamp
    } else {
      this.aggregatedData.set(keyString, {
        ...identity,
        count: 1,
        firstEvaluation: timestamp,
        lastEvaluation: timestamp,
        runtimeDefaultUsed: isRuntimeDefaultUsed(details),
      })
    }
    this.notify(() => ({
      type: 'add',
      aggregationId: `${this.generation}:${keyString}`,
      aggregationSize: this.aggregatedData.size,
      data: this.aggregatedData.get(keyString)!,
    }))
  }

  private notify(fields: () => AggregationDiagnostic): void {
    if (this.observe) {
      try {
        this.observe(fields())
      } catch {
        /* Diagnostics cannot change aggregation or delivery. */
      }
    }
  }

  flush(trigger = 'manual'): void {
    if (this.aggregatedData.size === 0) {
      return
    }

    const flushTimestamp = timeStampNow()
    const entries = Array.from(this.aggregatedData.entries())
    const events = entries.map(([key, data]) => {
      const event = createFlagEvaluationEvent(data, flushTimestamp)
      this.notify(() => ({
        type: 'flush',
        aggregationId: `${this.generation}:${key}`,
        aggregationSize: entries.length,
        data,
        event,
        trigger,
      }))
      return event
    })
    this.generation++
    this.aggregatedData.clear()
    this.onFlush(events)
  }
}

function readEnvironmentIdentity(metadata: FlagMetadata | undefined): EnvironmentIdentity | undefined {
  const id = metadata?.[ENVIRONMENT_ID_METADATA_KEY]
  const name = metadata?.[ENVIRONMENT_NAME_METADATA_KEY]
  if (typeof id !== 'string' || typeof name !== 'string' || (!id && !name)) return undefined
  return { ...(id ? { id } : {}), name }
}

function readEvaluationFeatures(metadata: FlagMetadata | undefined): Record<string, FeatureValue> | undefined {
  if (metadata?.[HAS_EVALUATION_FEATURES_METADATA_KEY] !== true) return undefined
  return featuresWithPrefix(metadata, METADATA_EVALUATION_FEATURE_PREFIX)
}

function canonicalEvaluationFeatures(metadata: FlagMetadata | undefined): Record<string, FeatureValue> | undefined {
  const features = readEvaluationFeatures(metadata)
  if (features === undefined) return undefined
  // Null prototype: a feature literally named `__proto__` must not hit the
  // inherited setter on an ordinary object.
  const canonical: Record<string, FeatureValue> = Object.create(null)
  for (const key of Object.keys(features).sort()) {
    canonical[key] = features[key]
  }
  return canonical
}

function getEvaluationTimestamp<T extends FlagValue>(details: EvaluationDetails<T>): TimeStamp {
  const metadataTimestamp = details.flagMetadata?.[EVALUATION_TIMESTAMP_METADATA_KEY]
  return Number.isFinite(metadataTimestamp) ? (metadataTimestamp as TimeStamp) : timeStampNow()
}

function isRuntimeDefaultUsed<T extends FlagValue>(details: EvaluationDetails<T>): boolean {
  // Datadog-assigned evaluations attach a platform variation key to OpenFeature
  // details.variant. Browser precomputed flags model variationKey as a string, and
  // server UFC variants are keyed by string. Default/error fallback paths omit the
  // variant, so nullish variant is the SDK-visible signal that the caller's default
  // value was returned.
  return details.variant == null
}
