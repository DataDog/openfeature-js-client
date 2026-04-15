# RFC: Detailed Flag Evaluation Trace for DD Flags Node SDK

**Status:** Draft
**Date:** 2026-04-14
**Author:** Tyler Potter

---

## Summary

Add a `DDFlagEvaluationDetails` type to the DD Flags Node SDK that surfaces the full
allocation waterfall trace — which allocations were evaluated and why each one was
skipped or matched. This data lives in the DD-internal evaluation layer and is
serialized to a JSON string at the OpenFeature provider boundary, where it is stored
in `flagMetadata`.

---

## Motivation

The current `evaluateForSubject()` function iterates through a flag's `allocations`
array in order (the "waterfall") and returns as soon as one matches. The resolved
`ResolutionDetails` tells callers:

- Which value was returned
- A coarse reason (`TARGETING_MATCH`, `DEFAULT`, `DISABLED`, `ERROR`)
- Which allocation key matched (`flagMetadata.allocationKey`)

It does **not** tell callers:

- Which allocations were evaluated before the match (or before falling through)
- Why each skipped allocation did not match (date range? targeting rules? traffic split?)
- Which targeting rule triggered the match
- Which allocations were never reached because the waterfall terminated earlier

This gap makes several use cases impractical or impossible:

- **Debugging mismatches** — a user is unexpectedly in (or out of) a treatment group;
  there is no way to see which allocations they were evaluated against.
- **Observability / telemetry** — there is a `targetingRuleKey` field in
  `FlagEvaluationEvent` and `FlagEvaluationAggregationKey` that is never populated
  because the evaluator discards the matched rule before returning. This RFC captures
  the matched rule index, which partially closes this gap; fully populating
  `targetingRuleKey` as a string requires a config format change (see Implementation
  Prerequisites).
- **Testing** — asserting which branch of the waterfall was exercised requires
  inspecting debug logs, which are not machine-readable.

### Prior Art: EPPO

The EPPO JS SDK solves this with a `FlagEvaluationDetailsBuilder` pattern
(`js-sdk-common/src/flag-evaluation-details-builder.ts`). The evaluator calls
`builder.addUnmatchedAllocation()` for each allocation that is skipped, records the
reason code, then calls `builder.setMatch()` when a match is found. Allocations after
the match point are automatically classified as `UNEVALUATED`.

EPPO's `AllocationEvaluationCode` enum:

```
UNEVALUATED           — never reached
MATCH                 — selected
BEFORE_START_TIME     — skipped: too early
AFTER_END_TIME        — skipped: too late
FAILING_RULE          — skipped: targeting rules did not match
TRAFFIC_EXPOSURE_MISS — skipped: rules matched, subject outside split ranges
```

The DD design follows this structure with naming adjustments to match DD conventions
and additional cases required by the DD evaluator.

---

## Background: How the Evaluator Works Today

There are two evaluation entry points with different responsibilities:

```
evaluate()                              [evaluation.ts]
  ├─ config loaded?         → ERROR (PROVIDER_NOT_READY)
  ├─ targetingKey present?  → ERROR (TARGETING_KEY_MISSING)
  ├─ flag exists?           → ERROR (FLAG_NOT_FOUND)
  └─ evaluateForSubject()   [evaluateForSubject.ts]
       ├─ flag.enabled?          → DISABLED
       ├─ type matches?          → TYPE_MISMATCH error
       └─ for each allocation:
            ├─ now < startAt?    → continue (silent)
            ├─ now >= endAt?     → continue (silent)
            ├─ containsMatchingRule()?
            │    → false         → continue (silent)
            └─ selectSplitUsingSharding()?
                 → null          → continue (silent)
                 → split         → variant = flag.variations[split.variationKey]
                                   ├─ variant exists  → return TARGETING_MATCH ✓
                                   └─ variant missing → continue (silent, config corrupt)
       └─ (fell through)         → return DEFAULT
```

Every `continue` discards evaluation state that is only surfaced in debug logs.
`ResolutionDetails` carries none of it. Notably, the `variant-not-found` fall-through
(split selected but `flag.variations[variationKey]` is undefined) is a silent failure
that is not currently distinguishable from a normal TRAFFIC_MISS.

`config.createdAt` and `config.environment.name` are already present on
`UniversalFlagConfigurationV1` and available inside `evaluate()`, but are never
threaded into `evaluateForSubject()`.

---

## Proposed Design

### Layer Separation

```
┌──────────────────────────────────────────────────────────┐
│  evaluate()  [evaluation.ts]                             │
│  Handles: config-not-loaded, missing targetingKey,       │
│           flag-not-found, unhandled exceptions           │
│  Returns: DDFlagEvaluationDetails (pre-waterfall cases)  │
└──────────────────┬───────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────┐
│  evaluateForSubject()  [evaluateForSubject.ts]           │
│  Handles: disabled, type mismatch, waterfall             │
│  Returns: DDFlagEvaluationDetails (rich structured trace)│
└──────────────────┬───────────────────────────────────────┘
                   │ provider maps to ResolutionDetails
┌──────────────────▼───────────────────────────────────────┐
│  OpenFeature provider boundary                           │
│  ResolutionDetails.flagMetadata                          │
│  { ddEvaluationTrace: string }  (opt-in serialization)   │
└──────────────────────────────────────────────────────────┘
```

Both `evaluate()` and `evaluateForSubject()` return `DDFlagEvaluationDetails`. The
provider calls `toResolutionDetails()` on the result of `evaluate()`, making all
paths — including pre-waterfall errors — observable through the same type.

---

### New Types

**File:** `packages/node-server/src/configuration/flagEvaluationDetails.ts`

```typescript
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
```

---

### Builder

**File:** `packages/node-server/src/configuration/flagEvaluationDetails.ts` (continued)

```typescript
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

export class DDFlagEvaluationDetailsBuilder<T> {
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
    // Guard against double-call: recordMatch being called twice would silently overwrite
    // the first match and produce a corrupted trace with no record of the first match.
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

  build(
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
      // Pre-waterfall outcomes never entered the allocation loop, so these lists
      // are meaningless and should not be populated.
      unmatchedAllocations: isPreWaterfall ? [] : this.unmatchedAllocations,
      unevaluatedAllocations: isPreWaterfall ? [] : this.calculateUnevaluated(),
      configFetchedAt: this.configFetchedAt,
      environmentName: this.environmentName,
    }
  }

  private calculateUnevaluated(): AllocationOutcome[] {
    const evaluatedCount =
      this.unmatchedAllocations.length + (this.matchedAllocation ? 1 : 0)
    // INVARIANT: recordUnmatched must be called exactly once for each allocation
    // in this.allocations order before build() is called. calculateUnevaluated
    // uses evaluatedCount as a slice index, which is only correct if the first
    // evaluatedCount allocations in this.allocations are exactly those for which
    // recordUnmatched/recordMatch was called, in order. The waterfall loop in
    // evaluateForSubject satisfies this by calling recordUnmatched on every
    // allocation it processes before continuing. Future callers of this builder
    // must preserve this invariant.
    return this.allocations.slice(evaluatedCount).map((allocation, i) => ({
      key: allocation.key,
      orderPosition: evaluatedCount + i + 1, // 1-indexed
      outcomeCode: AllocationOutcomeCode.UNEVALUATED,
      rulesPresent: !!allocation.rules?.length,
    }))
  }
}
```

---

### Changes to `evaluate()` — Pre-waterfall Error Paths

`evaluate()` currently returns `ResolutionDetails` directly for pre-waterfall errors.
It must be updated to return `DDFlagEvaluationDetails` and pass `config.createdAt` /
`config.environment.name` into the builder (or directly into `evaluateForSubject`).

For pre-waterfall outcomes the builder is constructed with an empty `allocations` array
since the flag config is either unavailable or we never reached the point of looking up
the flag:

```typescript
// evaluate.ts — pre-waterfall error paths now return DDFlagEvaluationDetails

export function evaluate<T extends FlagValueType>(
  config: UniversalFlagConfigurationV1 | undefined,
  type: T,
  flagKey: string,
  defaultValue: FlagTypeToValue<T>,
  context: EvaluationContext,
  logger: Logger,
): DDFlagEvaluationDetails<FlagTypeToValue<T>> {

  const configMeta = config
    ? { configFetchedAt: config.createdAt, environmentName: config.environment.name }
    : { configFetchedAt: null, environmentName: null }

  const noAllocBuilder = () =>
    new DDFlagEvaluationDetailsBuilder(flagKey, [], configMeta.configFetchedAt, configMeta.environmentName)

  if (!config) {
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.PROVIDER_NOT_READY,
      'Configuration is not loaded', null)
  }

  const { targetingKey: subjectKey, ...remainingContext } = context
  if (subjectKey == null) {
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING,
      'targetingKey is required but was not provided', null)
  }

  const flag = config.flags[flagKey]
  if (!flag) {
    logger.debug('returning default value because flag is not found', { flagKey, subjectKey })
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.FLAG_NOT_FOUND,
      `Flag '${flagKey}' not found in configuration`, null)
  }

  const subjectAttributes = { id: subjectKey, ...remainingContext }
  try {
    return evaluateForSubject(
      flag, type, subjectKey, subjectAttributes, defaultValue, logger,
      configMeta.configFetchedAt, configMeta.environmentName,
    )
  } catch (error) {
    // evaluateForSubject is an in-process pure function; exceptions here are programming
    // errors, not expected failure modes. We catch to preserve the OpenFeature contract
    // (evaluation must never throw), but the allocation trace from any mid-waterfall
    // progress is lost — the catch has no access to the builder inside evaluateForSubject.
    // The error message is threaded into outcomeDescription so it survives in the return
    // value; callers must not rely on this for production logic.
    logger.error('Error evaluating flag', { error })
    const description = error instanceof Error ? error.message : 'Unexpected error during evaluation'
    return noAllocBuilder().build(defaultValue, FlagEvaluationOutcomeCode.ERROR,
      description, flag.variationType)
  }
}
```

---

### Changes to `evaluateForSubject`

Signature change: accepts `configFetchedAt` and `environmentName` and returns
`DDFlagEvaluationDetails` instead of `ResolutionDetails`. Waterfall loop calls
`builder.recordUnmatched()` / `builder.recordMatch()` for each allocation:

```typescript
// Key changes — full function shown for clarity

export function evaluateForSubject<T extends FlagValueType>(
  flag: Flag,
  type: T,
  subjectKey: string,
  subjectAttributes: EvaluationContext,
  defaultValue: FlagTypeToValue<T>,
  logger: Logger,
  configFetchedAt: string | null,
  environmentName: string | null,
): DDFlagEvaluationDetails<FlagTypeToValue<T>> {

  const builder = new DDFlagEvaluationDetailsBuilder(
    flag.key, flag.allocations, configFetchedAt, environmentName,
  )

  if (!flag.enabled) {
    return builder.build(defaultValue, FlagEvaluationOutcomeCode.DISABLED,
      'Flag is disabled', flag.variationType)
  }

  if (!validateTypeMatch(type, flag.variationType)) {
    return builder.build(defaultValue, FlagEvaluationOutcomeCode.TYPE_MISMATCH,
      `Expected type '${type}' does not match flag variationType '${flag.variationType}'`,
      flag.variationType)
  }
  // DISABLED and TYPE_MISMATCH are in PRE_WATERFALL_CODES, so build() suppresses
  // unmatchedAllocations and unevaluatedAllocations for both outcomes. This is correct:
  // recordUnmatched is never called for either path (the allocations loop never ran),
  // so without PRE_WATERFALL_CODES the builder would incorrectly classify every allocation
  // in the flag as UNEVALUATED.

  const now = new Date()
  for (const [index, allocation] of flag.allocations.entries()) {
    const position = index + 1 // 1-indexed

    // allocation.startAt / endAt are typed as Date in ufc-v1.ts but runtime values are
    // ISO strings (the type is a known mismatch; wrapping with new Date() is required).
    if (allocation.startAt && now < new Date(allocation.startAt as unknown as string)) {
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.BEFORE_START_TIME)
      continue
    }

    if (allocation.endAt && now >= new Date(allocation.endAt as unknown as string)) {
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.AFTER_END_TIME)
      continue
    }

    const ruleMatchIndex = findMatchingRuleIndex(allocation.rules, subjectAttributes, logger)
    if (ruleMatchIndex === null) {
      // rules present but none matched
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.RULES_MISMATCH)
      continue
    }
    // ruleMatchIndex is a number (matched rule) or undefined (no rules, implicit match-all)

    const selectedSplit = selectSplitUsingSharding(allocation.splits, subjectKey, flag.key, logger)
    if (!selectedSplit) {
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.TRAFFIC_MISS, ruleMatchIndex)
      continue
    }

    const variant = flag.variations[selectedSplit.variationKey]
    if (!variant) {
      // Corrupt config: split references a variationKey that doesn't exist.
      // Log and continue to next allocation rather than short-circuiting.
      logger.warn('Split references unknown variationKey', {
        flagKey: flag.key, allocationKey: allocation.key,
        variationKey: selectedSplit.variationKey,
      })
      builder.recordUnmatched(allocation, position, AllocationOutcomeCode.MISSING_VARIATION, ruleMatchIndex)
      continue
    }

    builder.recordMatch(allocation, position, variant.key, ruleMatchIndex)
    return builder.build(
      variant.value as FlagTypeToValue<T>,
      FlagEvaluationOutcomeCode.MATCH,
      `Matched allocation '${allocation.key}'`,
      flag.variationType,
    )
  }

  return builder.build(defaultValue, FlagEvaluationOutcomeCode.DEFAULT,
    'No allocation matched; returning default value', flag.variationType)
}
```

---

### Changes to Rule Matching

`containsMatchingRule` currently returns `boolean`. It is split into two functions:
one returning the matched rule index (for the trace), and a wrapper preserving the
existing boolean API for any other call sites:

```typescript
/**
 * Returns the 0-indexed position of the first rule that matched,
 * undefined if no rules are defined (implicit match-all), or
 * null if rules are present and none matched.
 */
export function findMatchingRuleIndex(
  rules: Rule[] | undefined,
  subjectAttributes: EvaluationContext,
  logger: Logger,
): number | null | undefined {
  if (!rules?.length) return undefined   // no rules → implicit match-all
  logger.debug('evaluating rules', { rules: JSON.stringify(rules), subjectAttributes })
  const idx = rules.findIndex((rule) => matchesRule(rule, subjectAttributes))
  return idx === -1 ? null : idx
}

/**
 * Thin wrapper for call sites that need only a boolean result.
 * - undefined (no rules)  → true  (implicit match-all)
 * - number   (matched)    → true
 * - null     (no match)   → false
 *
 * Implementation note: the existing containsMatchingRule export in
 * evaluateForSubject.ts must be deleted as part of this change. It is currently
 * exported from that file and any call sites importing it from there must be
 * updated to import from rules.ts instead. Leaving both in place risks silent
 * divergence if either is changed independently.
 */
export function containsMatchingRule(
  rules: Rule[] | undefined,
  subjectAttributes: EvaluationContext,
  logger: Logger,
): boolean {
  return findMatchingRuleIndex(rules, subjectAttributes, logger) !== null
}
```

---

### OpenFeature Boundary Serialization

The provider converts `DDFlagEvaluationDetails` to `ResolutionDetails`. The
`ddEvaluationTrace` key in `flagMetadata` is opt-in and defaults to off to avoid
JSON serialization cost on every evaluation in high-throughput contexts:

```typescript
function toResolutionDetails<T extends FlagValueType>(
  details: DDFlagEvaluationDetails<FlagTypeToValue<T>>,
  requestedType: T,
  includeTrace: boolean,
): ResolutionDetails<FlagTypeToValue<T>> {
  // For pre-waterfall errors, variationType is null (no flag config available).
  // Fall back to the requested type T rather than hardcoding 'boolean', so downstream
  // consumers of flagMetadata.variationType get an accurate signal about the flag type
  // the caller was asking for.
  const flagMetadata: PrecomputedFlagMetadata & { ddEvaluationTrace?: string } = {
    allocationKey: details.allocationKey ?? '',
    variationType: details.variationType
      ? variantTypeToFlagValueType(details.variationType)
      : requestedType,
    doLog: details.doLog,
  }

  if (includeTrace) {
    flagMetadata.ddEvaluationTrace = JSON.stringify({
      flagKey: details.flagKey,
      variationKey: details.variationKey,
      allocationKey: details.allocationKey,
      outcomeCode: details.outcomeCode,
      outcomeDescription: details.outcomeDescription, // preserves error.message for ERROR outcomes
      matchedAllocation: details.matchedAllocation,
      unmatchedAllocations: details.unmatchedAllocations,
      unevaluatedAllocations: details.unevaluatedAllocations,
      environmentName: details.environmentName,
      configFetchedAt: details.configFetchedAt,
    })
  }

  return {
    value: details.value as FlagTypeToValue<T>,
    reason: outcomeCodeToReason(details.outcomeCode),
    variant: details.variationKey ?? undefined,
    errorCode: outcomeCodeToErrorCode(details.outcomeCode),
    flagMetadata,
  }
}

function outcomeCodeToReason(code: FlagEvaluationOutcomeCode): string {
  switch (code) {
    case FlagEvaluationOutcomeCode.MATCH:             return StandardResolutionReasons.TARGETING_MATCH
    case FlagEvaluationOutcomeCode.DISABLED:          return StandardResolutionReasons.DISABLED
    case FlagEvaluationOutcomeCode.DEFAULT:           return StandardResolutionReasons.DEFAULT
    default:                                          return StandardResolutionReasons.ERROR
  }
}

function outcomeCodeToErrorCode(code: FlagEvaluationOutcomeCode): ErrorCode | undefined {
  switch (code) {
    case FlagEvaluationOutcomeCode.PROVIDER_NOT_READY:     return ErrorCode.PROVIDER_NOT_READY
    case FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING:  return ErrorCode.TARGETING_KEY_MISSING
    case FlagEvaluationOutcomeCode.FLAG_NOT_FOUND:         return ErrorCode.FLAG_NOT_FOUND
    case FlagEvaluationOutcomeCode.TYPE_MISMATCH:          return ErrorCode.TYPE_MISMATCH
    case FlagEvaluationOutcomeCode.ERROR:                  return ErrorCode.GENERAL
    default:                                               return undefined
  }
}
```

---

## What Is Not Included (Intentionally)

### Per-condition failure detail

We expose `matchedRuleIndex` (which rule triggered the match) but not which
*condition* within a failing rule caused the mismatch.

This is left out for two reasons:

1. **Privacy** — condition evaluation includes the subject's attribute values.
   Surfacing `{ attribute: 'email', operator: ONE_OF, value: [...], subjectValue: 'user@example.com' }`
   at the telemetry layer requires a deliberate PII review before it can be included
   in any external payload.
2. **Scope** — `matchedRuleIndex` is sufficient for the primary use cases (debugging
   which branch of the waterfall fired). Per-condition tracing can be a follow-on.

### Shard assignment detail

The hash value and computed shard number for a `TRAFFIC_MISS` are not included.
They are deterministic from `(salt, subjectKey, totalShards)` and can be recalculated
offline. Including raw hash output adds noise without clear benefit.

---

## Implementation Prerequisites

### `targetingRuleKey` in `flagMetadata`

The existing `FlagEvaluationAggregator` reads `details.flagMetadata?.targetingRuleKey` to
populate `FlagEvaluationEvent.targeting_rule` — one of the stated motivations for this RFC
("Observability / telemetry" in the Motivation section). However, `toResolutionDetails`
cannot populate `flagMetadata.targetingRuleKey` with a string key because the current
`Rule` type has no `key` field:

```typescript
// ufc-v1.ts / rules.ts — current Rule type
export interface Rule {
  conditions: Condition[]  // no key field
}
```

This RFC captures `matchedRuleIndex` (integer position in `allocation.rules`) but cannot
derive a string key from it. Until the flag configuration format adds a stable `key` field
to `Rule`, `FlagEvaluationAggregationKey.targetingRuleKey` will remain unpopulated.

Options:
1. **Use index-as-string as a temporary key** — set `targetingRuleKey` to
   `String(matchedRuleIndex)` in `toResolutionDetails`. Functional but fragile: rule order
   changes in the flag config break historical comparisons.
2. **Add `key` to the `Rule` type and config format** — the proper fix, but requires a
   config format change and a coordinated backend deploy. This is a prerequisite for the
   observability use case to be fully realized.

This RFC does not resolve this gap. The trace (`ddEvaluationTrace`) includes
`matchedAllocation.matchedRuleIndex`, which is sufficient for ad-hoc debugging. The
telemetry aggregation path (`targeting_rule` in events) requires the config format change.

---

## Alternatives Considered

### Put everything in `flagMetadata` directly (no new internal type)

Rejected: imposes serialization cost on all callers unconditionally, collapses the
type system to untyped strings inside the DD layer, and makes the trace unavailable
to non-OpenFeature consumers of the SDK.

### Use `FlagEvaluationOutcomeCode` values that mirror `StandardResolutionReasons` directly

The `FlagEvaluationOutcomeCode` enum could be replaced by reusing
`StandardResolutionReasons` plus an `ErrorCode` field, matching the shape of
`ResolutionDetails`. This would eliminate the `outcomeCodeToReason()` mapping step.

Rejected because: `FlagEvaluationOutcomeCode` distinguishes cases that
`StandardResolutionReasons` collapses — specifically, `PROVIDER_NOT_READY`,
`TARGETING_KEY_MISSING`, `FLAG_NOT_FOUND`, and `TYPE_MISMATCH` all map to
`StandardResolutionReasons.ERROR` but are meaningfully different outcomes for
debugging and telemetry. Keeping a richer internal enum makes the DD layer
self-describing without requiring callers to cross-reference the `errorCode` field.

### Extend `ResolutionDetails` with a non-standard field

OpenFeature SDKs that wrap `ResolutionDetails` may strip unknown fields. Fragile at
the OF boundary and not forward-compatible with a future spec extension.

### Place the builder in `packages/core`

The builder pattern is currently only used by the node-server evaluator. If a
browser/client-side package is added that shares the same waterfall evaluation logic,
the builder should be promoted to `packages/core`. For now it belongs in
`packages/node-server` to avoid premature abstraction.

### Replicate the EPPO builder exactly

EPPO's builder takes the full `Allocation[]` at construction time and derives
`unevaluatedAllocations` by slicing, which is reused here. The main divergences:
- EPPO exposes the full matched `Rule` object; we expose only the index (privacy)
- EPPO has no equivalent of `MISSING_VARIATION` (not needed in their evaluator)
- Naming adjusted to DD conventions (`FAILING_RULE` → `RULES_MISMATCH`,
  `TRAFFIC_EXPOSURE_MISS` → `TRAFFIC_MISS`)

---

## Open Questions

1. **Should `outcomeDescription` be a constrained format?**
   Currently proposed as human-readable freeform. If it is to be indexed or alerted on,
   a structured format or enum may be preferable.

2. **Should `findMatchingRuleIndex` also record which conditions failed, behind a
   verbose flag?** Useful for deep debugging but requires a PII review before inclusion
   in any telemetry payload. Out of scope for this RFC.

3. **`includeTrace` as a provider config flag vs. always-on?** Serialization overhead
   is small per evaluation but accumulates at high throughput. Defaulting off is
   conservative; if the trace is always useful, remove the flag and always serialize.

4. **`MISSING_VARIATION` continue behavior — should it short-circuit instead?**
   The RFC proposes logging a warning and continuing the waterfall when a split
   selects a `variationKey` absent from `flag.variations`. The risk: the subject has
   already passed targeting rules and traffic sharding for that allocation. Continuing
   means they may match a later allocation and receive a `TARGETING_MATCH` result that
   appears legitimate but was only reached because of a corrupt earlier allocation.

   Two options:
   - **Hard fail with `ERROR`**: return immediately from `evaluateForSubject` with
     `FlagEvaluationOutcomeCode.ERROR` and `defaultValue`. Config corruption surfaces
     immediately; no misleading downstream match is possible.
   - **Continue with new top-level code**: keep the waterfall running but if the final
     outcome is reached through a `MISSING_VARIATION` allocation, mark the top-level
     `outcomeCode` as a new value (e.g. `CORRUPT_CONFIG`) rather than `MATCH` or `DEFAULT`.

   The current RFC implements "continue" because it mirrors how the existing evaluator
   behaves (silent fall-through). The team should decide whether surfacing corrupt config
   as a hard error is worth the behavior change.
