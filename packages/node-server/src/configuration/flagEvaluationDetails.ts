import type { FlagTypeToValue, PrecomputedFlagMetadata } from '@datadog/flagging-core'
import {
  ErrorCode,
  type FlagValueType,
  type ResolutionDetails,
  StandardResolutionReasons,
} from '@openfeature/server-sdk'
import type { Allocation } from './ufc-v1'
import { type VariantType, variantTypeToFlagValueType } from './ufc-v1'

/**
 * Why an individual allocation was skipped or selected during waterfall evaluation.
 */
export enum AllocationOutcomeCode {
  /** This allocation matched and its variant was returned. */
  MATCH = 'MATCH',
  /** Skipped: current time is before allocation.startAt. */
  BEFORE_START_TIME = 'BEFORE_START_TIME',
  /** Skipped: current time is at or after allocation.endAt. */
  AFTER_END_TIME = 'AFTER_END_TIME',
  /** Skipped: allocation has targeting rules and none of them matched. */
  RULES_MISMATCH = 'RULES_MISMATCH',
  /** Skipped: targeting rules matched but the subject fell outside all split ranges. */
  TRAFFIC_MISS = 'TRAFFIC_MISS',
  /**
   * Skipped: split was selected but the variationKey it references does not exist in
   * flag.variations. This indicates a corrupt or inconsistent flag configuration.
   * The waterfall continues to the next allocation.
   */
  MISSING_VARIATION = 'MISSING_VARIATION',
  /** Never evaluated: the waterfall terminated (matched or errored) before reaching this allocation. */
  UNEVALUATED = 'UNEVALUATED',
}

/**
 * Trace record for a single allocation in the waterfall.
 */
export interface AllocationOutcome {
  /** Matches Allocation.key from the flag configuration. */
  key: string
  /**
   * 1-indexed position of this allocation in flag.allocations.
   * Matches the ordering shown in the flag management UI.
   */
  orderPosition: number
  outcomeCode: AllocationOutcomeCode
  /**
   * Whether this allocation defined targeting rules.
   * Use this to distinguish "no rules (implicit match-all)" from
   * "rules present but matchedRuleIndex is not set" — a condition that
   * should not occur but is otherwise ambiguous.
   */
  rulesPresent: boolean
  /**
   * 0-indexed position of the rule that matched within allocation.rules.
   * Defined only when rulesPresent is true AND a rule matched
   * (i.e. outcomeCode is MATCH, TRAFFIC_MISS, or MISSING_VARIATION).
   * Undefined when rulesPresent is false (implicit match-all) or when
   * outcomeCode is RULES_MISMATCH.
   */
  matchedRuleIndex?: number
}

/**
 * Top-level outcome of a flag evaluation, covering both pre-waterfall
 * and waterfall outcomes.
 */
export enum FlagEvaluationOutcomeCode {
  /** A matching allocation was found and a variant was returned. */
  MATCH = 'MATCH',
  /** Flag is disabled; default value was returned. */
  DISABLED = 'DISABLED',
  /** Config is not loaded; default value was returned. */
  PROVIDER_NOT_READY = 'PROVIDER_NOT_READY',
  /** targetingKey was not present in evaluation context. */
  TARGETING_KEY_MISSING = 'TARGETING_KEY_MISSING',
  /** Flag key not present in configuration; default value was returned. */
  FLAG_NOT_FOUND = 'FLAG_NOT_FOUND',
  /** Expected type does not match the flag's variationType; default value was returned. */
  TYPE_MISMATCH = 'TYPE_MISMATCH',
  /** All allocations were evaluated and none matched; default value was returned. */
  DEFAULT = 'DEFAULT',
  /** An unexpected error occurred during evaluation; default value was returned. */
  ERROR = 'ERROR',
}

/**
 * Detailed result of a flag evaluation. This is the DD-internal type.
 * It is NOT directly exposed at the OpenFeature boundary — use toResolutionDetails()
 * to convert it there.
 *
 * unmatchedAllocations and unevaluatedAllocations are empty for all outcome codes
 * in PRE_WATERFALL_CODES (PROVIDER_NOT_READY, TARGETING_KEY_MISSING, FLAG_NOT_FOUND,
 * DISABLED, TYPE_MISMATCH, ERROR). They are only populated for MATCH and DEFAULT,
 * where the waterfall loop ran and allocation-level outcomes were recorded.
 */
export interface DDFlagEvaluationDetails<T> {
  flagKey: string
  /** The value returned to the caller (may be the supplied default). */
  value: T
  /** The key of the selected variation. Null when no allocation matched. */
  variationKey: string | null
  /** The key of the matched allocation. Null when no allocation matched. */
  allocationKey: string | null
  /** The variationType declared in the flag configuration. Null for pre-waterfall errors. */
  variationType: VariantType | null
  /**
   * Whether the matched allocation's doLog field was true.
   * False when no allocation matched or for pre-waterfall errors.
   */
  doLog: boolean

  outcomeCode: FlagEvaluationOutcomeCode
  /** Human-readable description of the outcome, suitable for debug logging. */
  outcomeDescription: string

  /**
   * The allocation that was selected, or null if none matched.
   * Non-null only when outcomeCode is MATCH.
   */
  matchedAllocation: AllocationOutcome | null

  /**
   * Allocations evaluated but not matched, in evaluation order.
   * Empty for pre-waterfall error outcomes (PROVIDER_NOT_READY, TARGETING_KEY_MISSING,
   * FLAG_NOT_FOUND, ERROR).
   */
  unmatchedAllocations: AllocationOutcome[]

  /**
   * Allocations never evaluated because the waterfall terminated first.
   * Empty for pre-waterfall error outcomes.
   */
  unevaluatedAllocations: AllocationOutcome[]

  /** ISO 8601 timestamp from config.createdAt. Null for pre-waterfall errors. */
  configFetchedAt: string | null
  /** Environment name from config.environment.name. Null for pre-waterfall errors. */
  environmentName: string | null
}

/**
 * Outcome codes where the waterfall never ran; unevaluated/unmatched lists are
 * always empty for these outcomes.
 *
 * DISABLED and TYPE_MISMATCH are included even though evaluateForSubject has access
 * to flag.allocations at that point. The builder is constructed before the enabled/type
 * checks but recordUnmatched is never called for them, so evaluatedCount === 0 and
 * calculateUnevaluated() would return all allocations as UNEVALUATED — which is
 * semantically wrong (the allocations were never candidates for evaluation, the flag
 * itself was gated). Including them here suppresses that misleading output.
 */
const PRE_WATERFALL_CODES = new Set<FlagEvaluationOutcomeCode>([
  FlagEvaluationOutcomeCode.PROVIDER_NOT_READY,
  FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING,
  FlagEvaluationOutcomeCode.FLAG_NOT_FOUND,
  FlagEvaluationOutcomeCode.DISABLED,
  FlagEvaluationOutcomeCode.TYPE_MISMATCH,
  FlagEvaluationOutcomeCode.ERROR,
])

export class DDFlagEvaluationDetailsBuilder {
  private variationKey: string | null = null
  private allocationKey: string | null = null
  private doLog = false
  private matchedAllocation: AllocationOutcome | null = null
  private readonly unmatchedAllocations: AllocationOutcome[] = []

  constructor(
    private readonly flagKey: string,
    private readonly allocations: Allocation[],
    private readonly configFetchedAt: string | null,
    private readonly environmentName: string | null,
  ) {}

  recordUnmatched(
    allocation: Allocation,
    position: number,
    outcomeCode: AllocationOutcomeCode,
    matchedRuleIndex?: number,
  ): this {
    this.unmatchedAllocations.push({
      key: allocation.key,
      orderPosition: position,
      outcomeCode,
      rulesPresent: !!allocation.rules?.length,
      matchedRuleIndex,
    })
    return this
  }

  recordMatch(
    allocation: Allocation,
    position: number,
    variationKey: string,
    matchedRuleIndex?: number,
  ): this {
    if (this.matchedAllocation !== null) {
      throw new Error(
        `recordMatch called twice on flag '${this.flagKey}': ` +
        `first match was allocation '${this.matchedAllocation.key}', ` +
        `second was '${allocation.key}'`
      )
    }
    this.variationKey = variationKey
    this.allocationKey = allocation.key
    this.doLog = !!allocation.doLog
    this.matchedAllocation = {
      key: allocation.key,
      orderPosition: position,
      outcomeCode: AllocationOutcomeCode.MATCH,
      rulesPresent: !!allocation.rules?.length,
      matchedRuleIndex,
    }
    return this
  }

  /**
   * Produce the final DDFlagEvaluationDetails.
   *
   * Each builder instance is intended for single use — `build()` should be called exactly once
   * after all `recordUnmatched`/`recordMatch` calls are complete. The method is generic on the
   * value type (`T`) rather than the class because the value type is not known at construction
   * time. As a consequence TypeScript does not prevent calling `build` twice on the same instance
   * with different `T` values; callers must not do this.
   */
  build<T>(
    value: T,
    outcomeCode: FlagEvaluationOutcomeCode,
    outcomeDescription: string,
    variationType: VariantType | null,
  ): DDFlagEvaluationDetails<T> {
    const isPreWaterfall = PRE_WATERFALL_CODES.has(outcomeCode)
    return {
      flagKey: this.flagKey,
      value,
      variationKey: this.variationKey,
      allocationKey: this.allocationKey,
      variationType,
      doLog: this.doLog,
      outcomeCode,
      outcomeDescription,
      matchedAllocation: this.matchedAllocation,
      unmatchedAllocations: isPreWaterfall ? [] : this.unmatchedAllocations,
      unevaluatedAllocations: isPreWaterfall ? [] : this.calculateUnevaluated(),
      configFetchedAt: this.configFetchedAt,
      environmentName: this.environmentName,
    }
  }

  private calculateUnevaluated(): AllocationOutcome[] {
    const evaluatedCount =
      this.unmatchedAllocations.length + (this.matchedAllocation ? 1 : 0)
    return this.allocations.slice(evaluatedCount).map((allocation, i) => ({
      key: allocation.key,
      orderPosition: evaluatedCount + i + 1, // 1-indexed
      outcomeCode: AllocationOutcomeCode.UNEVALUATED,
      rulesPresent: !!allocation.rules?.length,
    }))
  }
}

function outcomeCodeToReason(code: FlagEvaluationOutcomeCode): string {
  switch (code) {
    case FlagEvaluationOutcomeCode.MATCH:
      return StandardResolutionReasons.TARGETING_MATCH
    case FlagEvaluationOutcomeCode.DISABLED:
      return StandardResolutionReasons.DISABLED
    case FlagEvaluationOutcomeCode.DEFAULT:
      return StandardResolutionReasons.DEFAULT
    case FlagEvaluationOutcomeCode.PROVIDER_NOT_READY:
    case FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING:
    case FlagEvaluationOutcomeCode.FLAG_NOT_FOUND:
    case FlagEvaluationOutcomeCode.TYPE_MISMATCH:
    case FlagEvaluationOutcomeCode.ERROR:
      return StandardResolutionReasons.ERROR
    default: {
      // Exhaustiveness guard: TypeScript flags this if a new enum member is added without
      // updating this switch. The default is unreachable at runtime because FlagEvaluationOutcomeCode
      // is a closed string enum defined in this package — no external code produces new values.
      const _exhaustive: never = code
      return StandardResolutionReasons.ERROR
    }
  }
}

function outcomeCodeToErrorCode(code: FlagEvaluationOutcomeCode): ErrorCode | undefined {
  switch (code) {
    case FlagEvaluationOutcomeCode.PROVIDER_NOT_READY:
      return ErrorCode.PROVIDER_NOT_READY
    case FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING:
      return ErrorCode.TARGETING_KEY_MISSING
    case FlagEvaluationOutcomeCode.FLAG_NOT_FOUND:
      return ErrorCode.FLAG_NOT_FOUND
    case FlagEvaluationOutcomeCode.TYPE_MISMATCH:
      return ErrorCode.TYPE_MISMATCH
    case FlagEvaluationOutcomeCode.ERROR:
      return ErrorCode.GENERAL
    case FlagEvaluationOutcomeCode.MATCH:
    case FlagEvaluationOutcomeCode.DISABLED:
    case FlagEvaluationOutcomeCode.DEFAULT:
      return undefined
    default: {
      // Exhaustiveness guard: TypeScript flags this if a new enum member is added without
      // updating this switch. The default is unreachable at runtime (closed enum).
      const _exhaustive: never = code
      return undefined
    }
  }
}

export function toResolutionDetails<T extends FlagValueType>(
  details: DDFlagEvaluationDetails<FlagTypeToValue<T>>,
  requestedType: T,
  includeTrace: boolean,
): ResolutionDetails<FlagTypeToValue<T>> {
  const flagMetadata: PrecomputedFlagMetadata & { ddEvaluationTrace?: string } = {
    // PrecomputedFlagMetadata.allocationKey is typed as string (non-nullable) upstream.
    // For pre-waterfall outcomes (no allocation was ever matched), this produces '' rather
    // than null. Consumers should treat '' as "no allocation matched" for these cases.
    allocationKey: details.allocationKey ?? '',
    // variantTypeToFlagValueType throws for unknown VariantType values (e.g., if a new type
    // is deployed server-side before this SDK is updated). Fall back to requestedType rather
    // than throwing post-evaluation, which would violate the OpenFeature "never throw" contract.
    variationType: (() => {
      if (!details.variationType) return requestedType
      try {
        return variantTypeToFlagValueType(details.variationType)
      } catch {
        return requestedType
      }
    })(),
    doLog: details.doLog,
  }

  if (includeTrace) {
    // JSON.stringify can throw on circular references or non-serializable values (e.g. BigInt).
    // Guard to preserve the "evaluation must never throw" contract at the OpenFeature boundary.
    try {
      flagMetadata.ddEvaluationTrace = JSON.stringify({
        flagKey: details.flagKey,
        variationKey: details.variationKey,
        allocationKey: details.allocationKey,
        outcomeCode: details.outcomeCode,
        outcomeDescription: details.outcomeDescription,
        matchedAllocation: details.matchedAllocation,
        unmatchedAllocations: details.unmatchedAllocations,
        unevaluatedAllocations: details.unevaluatedAllocations,
        environmentName: details.environmentName,
        configFetchedAt: details.configFetchedAt,
      })
    } catch {
      flagMetadata.ddEvaluationTrace = '[trace serialization failed]'
    }
  }

  return {
    value: details.value,
    reason: outcomeCodeToReason(details.outcomeCode),
    variant: details.variationKey ?? undefined,
    errorCode: outcomeCodeToErrorCode(details.outcomeCode),
    flagMetadata,
  }
}
