import type { Channel } from 'node:diagnostics_channel'
import {
  type AssignmentCache,
  completeExposureDecision,
  createExposureEvent,
  type DependencyEvaluation,
  type DependencyExposureCandidate,
  type ExposureEvent,
  featuresWithPrefix,
  METADATA_EXPOSURE_FEATURE_PREFIX,
  prepareExposureDecision,
  timeStampNow,
} from '@datadog/flagging-core'
import type { EvaluationContext, FlagMetadata } from '@openfeature/core'
import type { EvaluationDetails, FlagValue, Hook, HookContext, ResolutionDetails } from '@openfeature/server-sdk'

type PreparedDependencyExposure = {
  details: Omit<EvaluationDetails<FlagValue>, 'value'> & { value?: FlagValue }
  event: ExposureEvent
}

type PreparedDependencyTelemetry = {
  dependencyEvaluations: readonly DependencyEvaluation[]
  dependencyExposures: readonly PreparedDependencyExposure[]
}

type StagedDependencyTelemetry = PreparedDependencyTelemetry & {
  rootMetadata: object
  rootContext: object
}

/**
 * Associates a completed dependency trace with the root result's metadata and evaluation context.
 * Evaluation and exposure hooks consume their respective batches from the same root lifecycle.
 * @internal
 */
export class DependencyTelemetrySidecar {
  private readonly batchesByMetadata = new WeakMap<object, StagedDependencyTelemetry>()
  private readonly batchesByContext = new WeakMap<object, StagedDependencyTelemetry>()

  constructor(readonly collectDependencyEvaluations = true) {}

  stage(rootMetadata: object, rootContext: object, telemetry: PreparedDependencyTelemetry): void {
    if (telemetry.dependencyEvaluations.length > 0 || telemetry.dependencyExposures.length > 0) {
      const batch = { ...telemetry, rootMetadata, rootContext }
      this.batchesByMetadata.set(rootMetadata, batch)
      this.batchesByContext.set(rootContext, batch)
    }
  }

  takeDependencyEvaluations(metadata: object | undefined, context?: object): readonly DependencyEvaluation[] {
    const batch = this.getBatch(metadata, context)
    if (batch === undefined) {
      return []
    }
    const evaluations = batch.dependencyEvaluations
    batch.dependencyEvaluations = []
    if (batch.dependencyExposures.length === 0) {
      this.deleteBatch(batch)
    }
    return evaluations
  }

  takeDependencyExposures(metadata: object | undefined): readonly PreparedDependencyExposure[] {
    if (metadata === undefined) {
      return []
    }
    const batch = this.batchesByMetadata.get(metadata)
    if (batch === undefined) {
      return []
    }
    const exposures = batch.dependencyExposures
    batch.dependencyExposures = []
    if (batch.dependencyEvaluations.length === 0) {
      this.deleteBatch(batch)
    }
    return exposures
  }

  discardDependencyExposures(metadata: object | undefined): void {
    if (metadata === undefined) {
      return
    }
    const batch = this.batchesByMetadata.get(metadata)
    if (batch === undefined) {
      return
    }
    batch.dependencyExposures = []
    if (batch.dependencyEvaluations.length === 0) {
      this.deleteBatch(batch)
    }
  }

  private getBatch(metadata: object | undefined, context: object | undefined): StagedDependencyTelemetry | undefined {
    return (
      (metadata === undefined ? undefined : this.batchesByMetadata.get(metadata)) ??
      (context === undefined ? undefined : this.batchesByContext.get(context))
    )
  }

  private deleteBatch(batch: StagedDependencyTelemetry): void {
    if (this.batchesByMetadata.get(batch.rootMetadata) === batch) {
      this.batchesByMetadata.delete(batch.rootMetadata)
    }
    if (this.batchesByContext.get(batch.rootContext) === batch) {
      this.batchesByContext.delete(batch.rootContext)
    }
  }
}

/** Structural contract: separately bundled entrypoints must not depend on class-private identity. @internal */
export type DependencyTelemetrySidecarApi = Pick<DependencyTelemetrySidecar, keyof DependencyTelemetrySidecar>

export function stageDependencyTelemetry(
  context: EvaluationContext,
  rootDetails: ResolutionDetails<FlagValue>,
  dependencyEvaluations: readonly DependencyEvaluation[],
  exposureCandidates: readonly DependencyExposureCandidate[],
  exposureCache: AssignmentCache | undefined,
  sidecar: DependencyTelemetrySidecarApi
): void {
  const rootMetadata = rootDetails.flagMetadata
  if (rootMetadata === undefined) {
    return
  }
  const prepared: PreparedDependencyExposure[] = []
  for (const evaluation of exposureCandidates) {
    const details = {
      ...evaluation.details,
      flagKey: evaluation.flagKey,
      flagMetadata: (evaluation.details.flagMetadata ?? {}) as FlagMetadata,
    }
    const exposure = prepareExposure(context, details, exposureCache)
    if (exposure !== undefined) prepared.push(exposure)
  }
  sidecar.stage(rootMetadata, context, {
    dependencyEvaluations,
    dependencyExposures: prepared,
  })
}

export function prepareExposure(
  context: EvaluationContext,
  details: PreparedDependencyExposure['details'],
  exposureCache: AssignmentCache | undefined
): PreparedDependencyExposure | undefined {
  try {
    const event = createExposureEvent(context, details)
    if (event === undefined) return
    if (exposureCache) prepareExposureDecision(details.flagMetadata, exposureCache, event)
    return { details, event }
  } catch {
    // Exposure preparation is best effort and must not affect assignment or evaluation telemetry.
    return
  }
}

/**
 * Publishes and records the exposure once the evaluation has completed without an
 * error. A cache entry is written even when nothing subscribes to the exposure
 * channel, so the verdict stays correct with Datadog exposure logging off.
 */
export class ExposureLoggingHook implements Hook {
  private readonly pending = new WeakMap<Readonly<HookContext<FlagValue>>, EvaluationDetails<FlagValue>>()

  constructor(
    private readonly exposureCache: AssignmentCache | undefined,
    private readonly exposureChannel: Channel<ExposureEvent>,
    private readonly dependencyTelemetrySidecar: DependencyTelemetrySidecarApi
  ) {}

  after(hookContext: Readonly<HookContext<FlagValue>>, evaluationDetails: EvaluationDetails<FlagValue>): void {
    this.pending.set(hookContext, evaluationDetails)
  }

  error(hookContext: Readonly<HookContext<FlagValue>>): void {
    const evaluationDetails = this.pending.get(hookContext)
    const metadata = evaluationDetails?.flagMetadata
    // A later hook failure rolls back transactional exposures, but dependency
    // evaluation telemetry remains observable from the root finally lifecycle.
    this.dependencyTelemetrySidecar.discardDependencyExposures(metadata)
    this.pending.delete(hookContext)
  }

  finally(hookContext: Readonly<HookContext<FlagValue>>): void {
    // Older supported OpenFeature versions pass only hook hints to finally.
    // Capture the successful result in after and discard it on any later error.
    const evaluationDetails = this.pending.get(hookContext)
    this.pending.delete(hookContext)
    if (evaluationDetails == null || evaluationDetails.errorCode !== undefined) {
      return
    }
    const metadata = evaluationDetails.flagMetadata as FlagMetadata | undefined
    if (metadata !== undefined) {
      const dependencyExposures = this.dependencyTelemetrySidecar.takeDependencyExposures(metadata)
      for (const dependencyExposure of dependencyExposures) {
        this.completeExposure(dependencyExposure.details, dependencyExposure.event)
      }
    }
    const details: EvaluationDetails<FlagValue> = {
      ...evaluationDetails,
      flagKey: evaluationDetails.flagKey ?? hookContext?.flagKey ?? '',
    }
    const exposureEvent = createExposureEvent(hookContext?.context ?? {}, details)
    if (exposureEvent !== undefined) {
      this.completeExposure(details, exposureEvent)
    }
  }

  private completeExposure(
    details: Omit<EvaluationDetails<FlagValue>, 'value'> & { value?: FlagValue },
    exposureEvent: ExposureEvent
  ): void {
    // One check-and-record after successful finalization; concurrent or nested
    // evaluations of the same assignment cannot both be admitted.
    const sharedDecision = completeExposureDecision(details)
    const metadata = details.flagMetadata as FlagMetadata | undefined
    if (metadata?.__dd_do_log !== true || metadata.__dd_exposure_cache_hit !== false) {
      return
    }
    try {
      if (this.exposureChannel.hasSubscribers) {
        // Features stay off the cache entry: a features change must not turn a
        // repeat exposure into a new one.
        const features = featuresWithPrefix(metadata, METADATA_EXPOSURE_FEATURE_PREFIX)
        const exposure = {
          ...exposureEvent,
          ...(features && { features }),
          timestamp: timeStampNow(),
        }
        // Never publish caller-owned objects. If structured cloning rejects an
        // unsupported value, fall back to a detached JSON-safe snapshot.
        const telemetryExposure = cloneForTelemetry(exposure)
        if (telemetryExposure !== undefined) this.exposureChannel.publish(telemetryExposure)
      }
      if (!sharedDecision) this.exposureCache?.set(exposureEvent)
    } catch {
      // Exposure reporting must never break the evaluation.
    }
  }
}

function cloneForTelemetry<T>(value: T): T | undefined {
  try {
    return structuredClone(value)
  } catch {
    try {
      const fallback = cloneTelemetryValue(value, new WeakSet())
      return fallback === unsupportedTelemetryValue ? undefined : (fallback as T)
    } catch {
      // Telemetry is best effort and must not affect flag evaluation semantics.
      return undefined
    }
  }
}

const unsupportedTelemetryValue = Symbol('unsupported telemetry value')

function cloneTelemetryValue(value: unknown, seen: WeakSet<object>): unknown | typeof unsupportedTelemetryValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value !== 'object' || seen.has(value)) return unsupportedTelemetryValue

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const clone: unknown[] = []
      for (const entry of value) {
        const clonedEntry = cloneTelemetryValue(entry, seen)
        if (clonedEntry !== unsupportedTelemetryValue) clone.push(clonedEntry)
      }
      return clone
    }

    const clone: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      let entry: unknown
      try {
        entry = (value as Record<string, unknown>)[key]
      } catch {
        continue
      }
      const clonedEntry = cloneTelemetryValue(entry, seen)
      if (clonedEntry !== unsupportedTelemetryValue) {
        Object.defineProperty(clone, key, { value: clonedEntry, enumerable: true, configurable: true, writable: true })
      }
    }
    return clone
  } finally {
    seen.delete(value)
  }
}
