import type { Logger } from '@openfeature/server-sdk'
import { evaluate } from '../src/configuration/evaluation'
import { evaluateForSubject } from '../src/configuration/evaluateForSubject'
import {
  AllocationOutcomeCode,
  DDFlagEvaluationDetailsBuilder,
  FlagEvaluationOutcomeCode,
  toResolutionDetails,
} from '../src/configuration/flagEvaluationDetails'
import type { Flag, UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'

const logger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}

const PAST = new Date(Date.now() - 86400_000).toISOString()
const FUTURE = new Date(Date.now() + 86400_000).toISOString()

const baseConfig: UniversalFlagConfigurationV1 = {
  createdAt: '2026-01-01T00:00:00Z',
  format: 'universal-flag-configuration',
  environment: { name: 'test-env' },
  flags: {},
}

function makeBooleanFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    key: 'test-flag',
    enabled: true,
    variationType: 'BOOLEAN',
    variations: {
      on: { key: 'on', value: true },
      off: { key: 'off', value: false },
    },
    allocations: [
      {
        key: 'default-alloc',
        splits: [{ variationKey: 'on', shards: [] }],
      },
    ],
    ...overrides,
  }
}

// ── Builder unit tests ────────────────────────────────────────────────────────

describe('DDFlagEvaluationDetailsBuilder', () => {
  const allocations = [
    { key: 'alloc-a', splits: [] },
    { key: 'alloc-b', splits: [] },
    { key: 'alloc-c', splits: [] },
  ]

  it('builds a MATCH outcome with correct allocation trace', () => {
    const builder = new DDFlagEvaluationDetailsBuilder('flag-x', allocations as never, null, null)
    builder.recordUnmatched(allocations[0] as never, 1, AllocationOutcomeCode.BEFORE_START_TIME)
    builder.recordMatch(allocations[1] as never, 2, 'variant-key', 0)
    const result = builder.build(true, FlagEvaluationOutcomeCode.MATCH, 'Matched', 'BOOLEAN')

    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.MATCH)
    expect(result.variationKey).toBe('variant-key')
    expect(result.allocationKey).toBe('alloc-b')
    expect(result.matchedAllocation).toMatchObject({
      key: 'alloc-b',
      orderPosition: 2,
      outcomeCode: AllocationOutcomeCode.MATCH,
      matchedRuleIndex: 0,
    })
    expect(result.unmatchedAllocations).toHaveLength(1)
    expect(result.unmatchedAllocations[0]).toMatchObject({
      key: 'alloc-a',
      orderPosition: 1,
      outcomeCode: AllocationOutcomeCode.BEFORE_START_TIME,
    })
    expect(result.unevaluatedAllocations).toHaveLength(1)
    expect(result.unevaluatedAllocations[0]).toMatchObject({
      key: 'alloc-c',
      orderPosition: 3,
      outcomeCode: AllocationOutcomeCode.UNEVALUATED,
    })
  })

  it('builds a DEFAULT outcome with all allocations unmatched', () => {
    const builder = new DDFlagEvaluationDetailsBuilder('flag-x', allocations as never, null, null)
    builder.recordUnmatched(allocations[0] as never, 1, AllocationOutcomeCode.RULES_MISMATCH)
    builder.recordUnmatched(allocations[1] as never, 2, AllocationOutcomeCode.TRAFFIC_MISS, 1)
    builder.recordUnmatched(allocations[2] as never, 3, AllocationOutcomeCode.AFTER_END_TIME)
    const result = builder.build(false, FlagEvaluationOutcomeCode.DEFAULT, 'No match', 'BOOLEAN')

    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.DEFAULT)
    expect(result.matchedAllocation).toBeNull()
    expect(result.unmatchedAllocations).toHaveLength(3)
    expect(result.unevaluatedAllocations).toHaveLength(0)
    expect(result.unmatchedAllocations[1].matchedRuleIndex).toBe(1)
  })

  it('suppresses allocation lists for pre-waterfall outcomes', () => {
    for (const code of [
      FlagEvaluationOutcomeCode.PROVIDER_NOT_READY,
      FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING,
      FlagEvaluationOutcomeCode.FLAG_NOT_FOUND,
      FlagEvaluationOutcomeCode.DISABLED,
      FlagEvaluationOutcomeCode.TYPE_MISMATCH,
      FlagEvaluationOutcomeCode.ERROR,
    ]) {
      const builder = new DDFlagEvaluationDetailsBuilder('flag-x', allocations as never, null, null)
      const result = builder.build(false, code, 'desc', 'BOOLEAN')
      expect(result.unmatchedAllocations).toHaveLength(0)
      expect(result.unevaluatedAllocations).toHaveLength(0)
    }
  })

  it('throws when recordMatch is called twice', () => {
    const builder = new DDFlagEvaluationDetailsBuilder('flag-x', allocations as never, null, null)
    builder.recordMatch(allocations[0] as never, 1, 'v1')
    expect(() => builder.recordMatch(allocations[1] as never, 2, 'v2')).toThrow(/recordMatch called twice/)
  })

  it('includes configFetchedAt and environmentName', () => {
    const builder = new DDFlagEvaluationDetailsBuilder('flag-x', [], '2026-01-01T00:00:00Z', 'prod')
    const result = builder.build(false, FlagEvaluationOutcomeCode.DEFAULT, 'desc', 'BOOLEAN')
    expect(result.configFetchedAt).toBe('2026-01-01T00:00:00Z')
    expect(result.environmentName).toBe('prod')
  })
})

// ── evaluateForSubject integration tests ─────────────────────────────────────

describe('evaluateForSubject waterfall trace', () => {
  it('records BEFORE_START_TIME for a future allocation — Date value', () => {
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'future-alloc', startAt: new Date(FUTURE), splits: [{ variationKey: 'on', shards: [] }] },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.BEFORE_START_TIME)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records BEFORE_START_TIME for a future allocation — ISO string value (JSON deserialization)', () => {
    // In production, config arrives as deserialized JSON so startAt/endAt are ISO strings,
    // not Date objects. The implementation handles this via the "as unknown as string" cast.
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'future-alloc', startAt: FUTURE as unknown as Date, splits: [{ variationKey: 'on', shards: [] }] },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.BEFORE_START_TIME)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records AFTER_END_TIME for an expired allocation — Date value', () => {
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'expired-alloc', endAt: new Date(PAST), splits: [{ variationKey: 'on', shards: [] }] },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.AFTER_END_TIME)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records AFTER_END_TIME for an expired allocation — ISO string value (JSON deserialization)', () => {
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'expired-alloc', endAt: PAST as unknown as Date, splits: [{ variationKey: 'on', shards: [] }] },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.AFTER_END_TIME)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records RULES_MISMATCH when targeting rules fail; rulesPresent is true', () => {
    const flag = makeBooleanFlag({
      allocations: [
        {
          key: 'us-only',
          rules: [{ conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['US'] }] }],
          splits: [{ variationKey: 'on', shards: [] }],
        },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(
      flag, 'boolean', 'user-1', { targetingKey: 'user-1', country: 'CA' }, false, logger, null, null,
    )
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.RULES_MISMATCH)
    expect(result.unmatchedAllocations[0].rulesPresent).toBe(true)
    expect(result.matchedAllocation?.key).toBe('fallback')
    // fallback has no rules → rulesPresent false
    expect(result.matchedAllocation?.rulesPresent).toBe(false)
  })

  it('records matchedRuleIndex when a rule matches; rulesPresent is true', () => {
    const flag = makeBooleanFlag({
      allocations: [
        {
          key: 'us-only',
          rules: [
            { conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['DE'] }] },
            { conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['US'] }] },
          ],
          splits: [{ variationKey: 'on', shards: [] }],
        },
      ],
    })
    const result = evaluateForSubject(
      flag, 'boolean', 'user-1', { targetingKey: 'user-1', country: 'US' }, false, logger, null, null,
    )
    expect(result.matchedAllocation?.matchedRuleIndex).toBe(1)
    expect(result.matchedAllocation?.rulesPresent).toBe(true)
  })

  it('records TRAFFIC_MISS when subject falls outside shard range; preserves matchedRuleIndex', () => {
    // Shards with an empty range [0,0) so no subject ever matches the split.
    const flag = makeBooleanFlag({
      allocations: [
        {
          key: 'narrow-split',
          rules: [{ conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['US'] }] }],
          splits: [{ variationKey: 'on', shards: [{ salt: 'test', ranges: [{ start: 0, end: 0 }], totalShards: 10000 }] }],
        },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(
      flag, 'boolean', 'user-1', { targetingKey: 'user-1', country: 'US' }, false, logger, null, null,
    )
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.TRAFFIC_MISS)
    expect(result.unmatchedAllocations[0].rulesPresent).toBe(true)
    // Rule index 0 matched (the only rule), so matchedRuleIndex should be 0
    expect(result.unmatchedAllocations[0].matchedRuleIndex).toBe(0)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records TRAFFIC_MISS with no matchedRuleIndex when allocation has no rules', () => {
    const flag = makeBooleanFlag({
      allocations: [
        {
          key: 'no-rules-narrow',
          splits: [{ variationKey: 'on', shards: [{ salt: 'test', ranges: [{ start: 0, end: 0 }], totalShards: 10000 }] }],
        },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(
      flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null,
    )
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.TRAFFIC_MISS)
    expect(result.unmatchedAllocations[0].rulesPresent).toBe(false)
    expect(result.unmatchedAllocations[0].matchedRuleIndex).toBeUndefined()
  })

  it('records MISSING_VARIATION when split points to non-existent variation; rulesPresent and matchedRuleIndex are false/undefined', () => {
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'corrupt-alloc', splits: [{ variationKey: 'does-not-exist', shards: [] }] },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.MISSING_VARIATION)
    expect(result.unmatchedAllocations[0].rulesPresent).toBe(false)
    expect(result.unmatchedAllocations[0].matchedRuleIndex).toBeUndefined()
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('records MISSING_VARIATION with matchedRuleIndex when allocation has rules', () => {
    const flag = makeBooleanFlag({
      allocations: [
        {
          key: 'corrupt-alloc',
          rules: [{ conditions: [{ operator: 'ONE_OF' as never, attribute: 'country', value: ['US'] }] }],
          splits: [{ variationKey: 'does-not-exist', shards: [] }],
        },
        { key: 'fallback', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(
      flag, 'boolean', 'user-1', { targetingKey: 'user-1', country: 'US' }, false, logger, null, null,
    )
    expect(result.unmatchedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.MISSING_VARIATION)
    expect(result.unmatchedAllocations[0].rulesPresent).toBe(true)
    expect(result.unmatchedAllocations[0].matchedRuleIndex).toBe(0)
    expect(result.matchedAllocation?.key).toBe('fallback')
  })

  it('marks remaining allocations as UNEVALUATED after a match', () => {
    const flag = makeBooleanFlag({
      allocations: [
        { key: 'first', splits: [{ variationKey: 'on', shards: [] }] },
        { key: 'second', splits: [{ variationKey: 'off', shards: [] }] },
        { key: 'third', splits: [{ variationKey: 'off', shards: [] }] },
      ],
    })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.matchedAllocation?.key).toBe('first')
    expect(result.unevaluatedAllocations).toHaveLength(2)
    expect(result.unevaluatedAllocations[0].outcomeCode).toBe(AllocationOutcomeCode.UNEVALUATED)
    expect(result.unevaluatedAllocations[0].orderPosition).toBe(2)
    expect(result.unevaluatedAllocations[1].orderPosition).toBe(3)
  })

  it('returns DISABLED outcome without allocation lists', () => {
    const flag = makeBooleanFlag({ enabled: false })
    const result = evaluateForSubject(flag, 'boolean', 'user-1', { targetingKey: 'user-1' }, false, logger, null, null)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.DISABLED)
    expect(result.unmatchedAllocations).toHaveLength(0)
    expect(result.unevaluatedAllocations).toHaveLength(0)
  })

  it('returns TYPE_MISMATCH outcome without allocation lists', () => {
    const flag = makeBooleanFlag() // BOOLEAN flag
    const result = evaluateForSubject(flag, 'string', 'user-1', { targetingKey: 'user-1' }, 'default', logger, null, null)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.TYPE_MISMATCH)
    expect(result.unmatchedAllocations).toHaveLength(0)
    expect(result.unevaluatedAllocations).toHaveLength(0)
  })
})

// ── evaluate() pre-waterfall paths ───────────────────────────────────────────

describe('evaluate() pre-waterfall paths', () => {
  it('returns PROVIDER_NOT_READY when config is undefined; variationType is null', () => {
    const result = evaluate(undefined, 'boolean', 'my-flag', false, { targetingKey: 'u' }, logger)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.PROVIDER_NOT_READY)
    expect(result.variationType).toBeNull()
    expect(result.configFetchedAt).toBeNull()
    expect(result.environmentName).toBeNull()
  })

  it('returns FLAG_NOT_FOUND when flag does not exist; variationType is null', () => {
    const result = evaluate(baseConfig, 'boolean', 'missing-flag', false, { targetingKey: 'u' }, logger)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.FLAG_NOT_FOUND)
    expect(result.variationType).toBeNull()
    expect(result.configFetchedAt).toBe(baseConfig.createdAt)
    expect(result.environmentName).toBe('test-env')
  })

  it('returns ERROR outcome when evaluateForSubject throws unexpectedly', () => {
    // A flag with a variationType that is unknown at runtime causes variantTypeToFlagValueType
    // to throw inside validateTypeMatch, which propagates to evaluate()'s catch block.
    const config = {
      ...baseConfig,
      flags: {
        'bad-flag': {
          ...makeBooleanFlag(),
          variationType: 'UNKNOWN_TYPE' as never,
        },
      },
    }
    const result = evaluate(config, 'boolean', 'bad-flag', false, { targetingKey: 'u' }, logger)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.ERROR)
    expect(result.unmatchedAllocations).toHaveLength(0)
    expect(result.unevaluatedAllocations).toHaveLength(0)
  })

  it('returns TARGETING_KEY_MISSING when sharding requires a key but none is provided', () => {
    const config: UniversalFlagConfigurationV1 = {
      ...baseConfig,
      flags: {
        'sharded-flag': makeBooleanFlag({
          key: 'sharded-flag',
          allocations: [
            {
              key: 'alloc',
              splits: [{ variationKey: 'on', shards: [{ salt: 's', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }] }],
            },
          ],
        }),
      },
    }
    const result = evaluate(config, 'boolean', 'sharded-flag', false, {}, logger)
    expect(result.outcomeCode).toBe(FlagEvaluationOutcomeCode.TARGETING_KEY_MISSING)
    // variationType comes from the flag config, not null, since we reached evaluateForSubject
    expect(result.variationType).toBe('BOOLEAN')
  })

  it('threads configFetchedAt and environmentName into the result', () => {
    const config: UniversalFlagConfigurationV1 = {
      ...baseConfig,
      flags: { 'test-flag': makeBooleanFlag() },
    }
    const result = evaluate(config, 'boolean', 'test-flag', false, { targetingKey: 'u' }, logger)
    expect(result.configFetchedAt).toBe('2026-01-01T00:00:00Z')
    expect(result.environmentName).toBe('test-env')
  })
})

// ── toResolutionDetails ───────────────────────────────────────────────────────

describe('toResolutionDetails', () => {
  const config: UniversalFlagConfigurationV1 = {
    ...baseConfig,
    flags: { 'test-flag': makeBooleanFlag() },
  }

  it('returns correct ResolutionDetails for a MATCH', () => {
    const details = evaluate(config, 'boolean', 'test-flag', false, { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.value).toBe(true)
    expect(resolution.reason).toBe('TARGETING_MATCH')
    expect(resolution.errorCode).toBeUndefined()
    expect(resolution.flagMetadata?.ddEvaluationTrace).toBeUndefined()
  })

  it('includes ddEvaluationTrace when includeTrace is true', () => {
    const details = evaluate(config, 'boolean', 'test-flag', false, { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'boolean', true)
    expect(resolution.flagMetadata?.ddEvaluationTrace).toBeDefined()
    const trace = JSON.parse(resolution.flagMetadata!.ddEvaluationTrace as string)
    expect(trace.outcomeCode).toBe(FlagEvaluationOutcomeCode.MATCH)
    expect(trace.matchedAllocation).toBeDefined()
    expect(trace.unmatchedAllocations).toHaveLength(0)
    expect(trace.environmentName).toBe('test-env')
    expect(trace.configFetchedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('maps DISABLED to DISABLED reason', () => {
    const details = evaluate(
      { ...config, flags: { 'test-flag': makeBooleanFlag({ enabled: false }) } },
      'boolean', 'test-flag', false, { targetingKey: 'u' }, logger,
    )
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.reason).toBe('DISABLED')
  })

  it('maps FLAG_NOT_FOUND to ERROR reason with FLAG_NOT_FOUND errorCode', () => {
    const details = evaluate(config, 'boolean', 'no-such-flag', false, { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.reason).toBe('ERROR')
    expect(resolution.errorCode).toBe('FLAG_NOT_FOUND')
  })

  it('maps TYPE_MISMATCH to ERROR reason with TYPE_MISMATCH errorCode', () => {
    const details = evaluate(config, 'string', 'test-flag', 'def', { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'string', false)
    expect(resolution.reason).toBe('ERROR')
    expect(resolution.errorCode).toBe('TYPE_MISMATCH')
  })

  it('falls back to requestedType for variationType when flag is not found', () => {
    const details = evaluate(config, 'boolean', 'no-such-flag', false, { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.flagMetadata?.variationType).toBe('boolean')
  })

  it('maps DEFAULT to DEFAULT reason with no errorCode', () => {
    const details = evaluate(
      { ...config, flags: { 'test-flag': makeBooleanFlag({ allocations: [] }) } },
      'boolean', 'test-flag', false, { targetingKey: 'u' }, logger,
    )
    expect(details.outcomeCode).toBe(FlagEvaluationOutcomeCode.DEFAULT)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.reason).toBe('DEFAULT')
    expect(resolution.errorCode).toBeUndefined()
  })

  it('maps PROVIDER_NOT_READY to ERROR reason with PROVIDER_NOT_READY errorCode', () => {
    const details = evaluate(undefined, 'boolean', 'any-flag', false, { targetingKey: 'u' }, logger)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.reason).toBe('ERROR')
    expect(resolution.errorCode).toBe('PROVIDER_NOT_READY')
  })

  it('maps TARGETING_KEY_MISSING to ERROR reason with TARGETING_KEY_MISSING errorCode', () => {
    const shardedConfig: UniversalFlagConfigurationV1 = {
      ...config,
      flags: {
        'test-flag': makeBooleanFlag({
          allocations: [{
            key: 'alloc',
            splits: [{ variationKey: 'on', shards: [{ salt: 's', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }] }],
          }],
        }),
      },
    }
    const details = evaluate(shardedConfig, 'boolean', 'test-flag', false, {}, logger)
    const resolution = toResolutionDetails(details, 'boolean', false)
    expect(resolution.reason).toBe('ERROR')
    expect(resolution.errorCode).toBe('TARGETING_KEY_MISSING')
  })
})
