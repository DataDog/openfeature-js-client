import { createHash } from 'node:crypto'
import { fromJson, type JsonObject } from '@bufbuild/protobuf'
import type { EvaluationContext } from '@openfeature/core'
import { evaluate } from '../evaluation/evaluation'
import * as clock from '../time'
import type { FlagsConfiguration } from './configuration'
import { createExposureEvent } from './exposureEvent'
import { FlagsConfigurationSchema } from './generated/ufc_pb'
import {
  ConfigurationPrecomputeError,
  type PrecomputeConfigurationOptions,
  precomputeConfiguration,
} from './precompute-configuration'
import { configurationFromRulesBinary } from './rules-wire'
import { encodeFlagsConfiguration } from './ufc-protobuf'
import { configurationFromString, configurationToString } from './wire'

const now = new Date('2026-10-30T12:00:00Z')
const context = { targetingKey: 'subject', country: 'US' }

function flag(overrides: JsonObject = {}): JsonObject {
  return {
    variationType: 'VARIATION_TYPE_BOOLEAN',
    variations: [{ keyStringIndex: 0, booleanValue: true }],
    allocations: [{ key: 'allocation', splits: [{ variationIndex: 0, reason: 'REASON_STATIC' }] }],
    ...overrides,
  }
}

function rules(flags: JsonObject = { flag: flag() }, overrides: JsonObject = {}): FlagsConfiguration {
  return configurationFromRulesBinary(
    encodeFlagsConfiguration(
      fromJson(FlagsConfigurationSchema, {
        environmentName: 'test',
        createdAt: '2026-01-01T00:00:00Z',
        strings: ['on', 'off', 'hello', 'country', 'US'],
        flags,
        ...overrides,
      })
    )
  )
}

function roundTrip(configuration: FlagsConfiguration): FlagsConfiguration {
  return configurationFromString(configurationToString(configuration))
}

beforeEach(() => jest.useFakeTimers().setSystemTime(now))
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('precomputeConfiguration', () => {
  it.each([
    ['BOOLEAN', { booleanValue: false }, 'boolean', false],
    ['STRING', { stringValueIndex: 2 }, 'string', 'hello'],
    ['INTEGER', { integerValue: '42' }, 'number', 42],
    ['NUMERIC', { numericValue: 3.5 }, 'number', 3.5],
    ['JSON', { jsonStringIndex: 0 }, 'object', { nested: [true, null, 42] }],
  ] as const)('precomputes %s without substituting defaults', (type, variation, expectedType, value) => {
    const input = rules(
      { flag: flag({ variationType: `VARIATION_TYPE_${type}`, variations: [{ keyStringIndex: 0, ...variation }] }) },
      { jsonStrings: [JSON.stringify(value)] }
    )
    const result = precomputeConfiguration(input, context)
    expect(result).toEqual({
      precomputed: {
        context,
        fetchedAt: now.getTime(),
        response: {
          data: {
            attributes: {
              createdAt: now.toISOString(),
              format: 'PRECOMPUTED',
              obfuscated: false,
              environment: { name: 'test' },
              observeFullEvaluationData: false,
              flags: {
                flag: {
                  allocationKey: 'allocation',
                  variationKey: 'on',
                  variationType: expectedType,
                  variationValue: value,
                  doLog: false,
                  reason: 'STATIC',
                },
              },
            },
          },
        },
      },
    })
    expect(roundTrip(result)).toEqual(result)
    expect(evaluate(roundTrip(result), expectedType, 'flag', null, context)).toMatchObject({
      value,
      variant: 'on',
      reason: 'STATIC',
    })
  })

  // Rust precomputed.rs explicitly preserves scalar/null JSON with variationType "object".
  it.each([null, 'scalar-json', true, 42, 3.5, [1, false]])('round-trips JSON assignment %j', (value) => {
    const input = rules(
      { flag: flag({ variationType: 'VARIATION_TYPE_JSON', variations: [{ jsonStringIndex: 0 }] }) },
      { jsonStrings: [JSON.stringify(value)] }
    )
    const result = roundTrip(precomputeConfiguration(input, context))
    expect(result.precomputed?.flagErrors).toBeUndefined()
    expect(evaluate(result, 'object', 'flag', { fallback: true }, context)).toMatchObject({ value, reason: 'STATIC' })
  })

  it.each([0, 123])(
    'preserves serial %i, raw split features and consent, but never source rules or ETags',
    (serialId) => {
      const features = [
        { key: 'experiment', value: 'checkout', destinations: ['HOOK', 'EXPOSURE'] },
        { key: 'metric', value: 2, destinations: ['EVALUATION'] },
        { key: 'future', value: true, destinations: ['FUTURE_DESTINATION'] },
      ]
      const input = rules(
        {
          flag: flag({
            allocations: [
              {
                key: 'experiment-allocation',
                logExposureEvent: true,
                splits: [
                  {
                    reason: 'REASON_SPLIT',
                    serialId,
                    features: features.map(({ value, ...feature }) => ({
                      ...feature,
                      ...(typeof value === 'string'
                        ? { stringValue: value }
                        : typeof value === 'number'
                          ? { numberValue: value }
                          : { boolValue: value }),
                    })),
                  },
                ],
              },
            ],
          }),
        },
        { observeFullEvaluationData: true }
      )
      input.rules!.etag = 'rules-etag'
      const direct = evaluate(input, 'boolean', 'flag', false, context)
      expect(direct.flagMetadata?.__dd_split_serial_id).toBe(serialId)
      expect(
        createExposureEvent(context, { ...direct, flagKey: 'flag', flagMetadata: direct.flagMetadata ?? {} })?.serial_id
      ).toBe(serialId)
      const result = roundTrip(precomputeConfiguration(input, context))
      expect(result.rules).toBeUndefined()
      expect(result.precomputed?.etag).toBeUndefined()
      expect(result.precomputed?.response.data.attributes).toMatchObject({
        observeFullEvaluationData: true,
        flags: {
          flag: { allocationKey: 'experiment-allocation', reason: 'SPLIT', doLog: true, serialId, features },
        },
      })
      expect(evaluate(result, 'boolean', 'flag', false, context).flagMetadata).toMatchObject({
        __dd_split_serial_id: serialId,
        '__dd_feature.experiment': 'checkout',
        '__dd_exposure_feature.experiment': 'checkout',
        '__dd_evaluation_feature.metric': 2,
        __dd_has_evaluation_features: true,
      })
    }
  )

  it.each([
    ['NaN', []],
    ['Infinity', []],
    ['-Infinity', []],
    ['NaN', ['HOOK']],
    ['Infinity', ['HOOK']],
    ['-Infinity', ['HOOK']],
  ])('retains assignments with nonportable feature %s for %j', (numberValue, destinations) => {
    const input = rules({
      flag: flag({
        allocations: [
          {
            key: 'allocation',
            splits: [
              {
                reason: 'REASON_STATIC',
                features: [
                  { key: 'invalid', numberValue, destinations },
                  { key: 'valid', numberValue: 42, destinations: ['HOOK', 'EXPOSURE'] },
                ],
              },
            ],
          },
        ],
      }),
    })
    expect(evaluate(input, 'boolean', 'flag', false, context)).toMatchObject({ value: true, reason: 'STATIC' })
    const onEvaluationError = jest.fn()
    const result = roundTrip(precomputeConfiguration(input, context, { onEvaluationError }))
    expect(evaluate(result, 'boolean', 'flag', false, context)).toMatchObject({
      value: true,
      reason: 'STATIC',
      flagMetadata: { '__dd_feature.valid': 42, '__dd_exposure_feature.valid': 42 },
    })
    expect(result.precomputed?.response.data.attributes.flags.flag.features).toEqual([
      { key: 'valid', value: 42, destinations: ['HOOK', 'EXPOSURE'] },
    ])
    expect(onEvaluationError).not.toHaveBeenCalled()
  })

  it('omits unassigned and failed flags but retains a successful DEFAULT-reason assignment', () => {
    const input = rules({
      assigned: flag({ allocations: [{ key: 'default', splits: [{ reason: 'REASON_DEFAULT' }] }] }),
      unassigned: flag({ allocations: [] }),
      unsupported: flag({ minimumFeatureLevel: 999 }),
      unsafeInteger: flag({
        variationType: 'VARIATION_TYPE_INTEGER',
        variations: [{ integerValue: '9007199254740993' }],
      }),
      badJson: flag({ variationType: 'VARIATION_TYPE_JSON', variations: [{ jsonStringIndex: 999 }] }),
      good: flag(),
    })
    const onEvaluationError = jest.fn()
    const result = roundTrip(precomputeConfiguration(input, context, { onEvaluationError }))
    expect(Object.keys(result.precomputed!.response.data.attributes.flags)).toEqual(['assigned', 'good'])
    expect(evaluate(result, 'boolean', 'assigned', false, context)).toMatchObject({ value: true, reason: 'DEFAULT' })
    expect(onEvaluationError.mock.calls).toEqual([
      [{ flagKey: 'unsupported', errorCode: 'PARSE_ERROR' }],
      [{ flagKey: 'unsafeInteger', errorCode: 'PARSE_ERROR' }],
      [{ flagKey: 'badJson', errorCode: 'PARSE_ERROR' }],
    ])
    for (const key of ['unassigned', 'unsupported', 'unsafeInteger', 'badJson']) {
      expect(evaluate(result, 'boolean', key, false, context)).toMatchObject({
        value: false,
        errorCode: 'FLAG_NOT_FOUND',
      })
    }
  })

  it('uses rules even if a matching precomputed capability is already present', () => {
    const input = rules()
    input.precomputed = precomputeConfiguration(rules({}), context).precomputed
    expect(evaluate(precomputeConfiguration(input, context), 'boolean', 'flag', false, context).value).toBe(true)
  })

  it('binds a detached context, supports empty rules, and rejects evaluation with another context', () => {
    const subject = { ...context, nested: { plans: ['free'] } }
    const result = precomputeConfiguration(rules(), subject)
    subject.nested.plans.push('paid')
    expect(result.precomputed?.context).toEqual({ ...context, nested: { plans: ['free'] } })
    expect(evaluate(result, 'boolean', 'flag', false, subject)).toMatchObject({ errorCode: 'INVALID_CONTEXT' })
    expect(precomputeConfiguration(rules({}), {}).precomputed?.context).toEqual({})
    expect(roundTrip(precomputeConfiguration(rules({}), {})).precomputed?.response.data.attributes.flags).toEqual({})
  })

  it('does not expose cached JSON or raw feature arrays through the output', () => {
    const input = rules(
      {
        flag: flag({
          variationType: 'VARIATION_TYPE_JSON',
          variations: [{ jsonStringIndex: 0 }],
          allocations: [
            {
              key: 'allocation',
              splits: [
                { reason: 'REASON_STATIC', features: [{ key: 'feature', boolValue: true, destinations: ['HOOK'] }] },
              ],
            },
          ],
        }),
      },
      { jsonStrings: ['{"nested":[1]}'] }
    )
    const first = precomputeConfiguration(input, context)
    const assignment = first.precomputed!.response.data.attributes.flags.flag
    const value = assignment.variationValue as { nested: number[] }
    value.nested.push(2)
    const features = assignment.features as Array<{ destinations: string[] }>
    features[0].destinations.push('EXPOSURE')
    expect(precomputeConfiguration(input, context).precomputed?.response.data.attributes.flags.flag).toMatchObject({
      variationValue: { nested: [1] },
      features: [{ key: 'feature', value: true, destinations: ['HOOK'] }],
    })
  })

  it('omits a JSON assignment that cannot be represented faithfully in the portable wire', () => {
    const input = rules(
      {
        bad: flag({ variationType: 'VARIATION_TYPE_JSON', variations: [{ jsonStringIndex: 0 }] }),
        good: flag(),
      },
      { jsonStrings: ['{"overflow":1e400}'] }
    )
    const onEvaluationError = jest.fn()
    const result = roundTrip(precomputeConfiguration(input, context, { onEvaluationError }))
    expect(Object.keys(result.precomputed!.response.data.attributes.flags)).toEqual(['good'])
    expect(onEvaluationError).toHaveBeenCalledWith({ flagKey: 'bad', errorCode: 'PARSE_ERROR' })
  })

  it('evaluates targeting and sharding for the requested subject', () => {
    const input = rules(
      {
        flag: flag({
          variations: [{ booleanValue: true }, { keyStringIndex: 1, booleanValue: false }],
          allocations: [
            {
              key: 'us',
              targetingConditionIndex: 0,
              partitionKey: [{ shardMd5: { attributeIndex: 1, salt: 'test', totalShards: '100' } }],
              splits: [{ reason: 'REASON_TARGETING_MATCH', ranges: [{ from: '0', to: '100' }] }],
            },
            { key: 'other', splits: [{ variationIndex: 1, reason: 'REASON_DEFAULT' }] },
          ],
        }),
        static: flag(),
      },
      {
        attributes: [{ attributePath: { segments: [{ objectKeyStringIndex: 3 }] } }, { targetingKey: {} }],
        conditions: [{ stringMembership: { attributeIndex: 0, stringIndexes: [4] } }],
      }
    )
    for (const [country, value, reason] of [
      ['US', true, 'TARGETING_MATCH'],
      ['FR', false, 'DEFAULT'],
    ] as const) {
      const subject = { ...context, country }
      expect(
        evaluate(roundTrip(precomputeConfiguration(input, subject)), 'boolean', 'flag', !value, subject)
      ).toMatchObject({ value, reason })
    }
    const onEvaluationError = jest.fn()
    const result = precomputeConfiguration(input, { country: 'US' }, { onEvaluationError })
    expect(Object.keys(result.precomputed!.response.data.attributes.flags)).toEqual(['static'])
    expect(onEvaluationError).toHaveBeenCalledWith({ flagKey: 'flag', errorCode: 'TARGETING_KEY_MISSING' })
  })

  it('selects different splits for distinct subjects across repeated snapshots', () => {
    const input = rules(
      {
        flag: flag({
          variations: [{ booleanValue: true }, { keyStringIndex: 1, booleanValue: false }],
          allocations: [
            {
              key: 'allocation',
              partitionKey: [{ shardMd5: { attributeIndex: 0, salt: '', totalShards: '100' } }],
              splits: [
                { variationIndex: 0, reason: 'REASON_SPLIT', ranges: [{ from: '0', to: '75' }] },
                { variationIndex: 1, reason: 'REASON_SPLIT', ranges: [{ from: '75', to: '100' }] },
              ],
            },
          ],
        }),
        static: flag(),
      },
      { attributes: [{ targetingKey: {} }] }
    )
    for (const [targetingKey, shard, value, variant] of [
      ['a', 77, false, 'off'],
      ['b', 70, true, 'on'],
      ['a', 77, false, 'off'],
    ] as const) {
      expect(createHash('md5').update(targetingKey).digest().readUInt32BE(0) % 100).toBe(shard)
      const subject = { targetingKey, country: 'US' }
      const snapshot = precomputeConfiguration(input, subject)
      for (const result of [snapshot, roundTrip(snapshot)]) {
        expect(result.precomputed?.context).toEqual(subject)
        expect(evaluate(result, 'boolean', 'flag', !value, subject)).toMatchObject({ value, variant, reason: 'SPLIT' })
        expect(evaluate(result, 'boolean', 'static', false, subject).value).toBe(true)
      }
    }
  })

  it('captures the time once for all time-partitioned flags', () => {
    const timedFlag = flag({
      allocations: [
        {
          key: 'time',
          partitionKey: [{ time: {} }],
          splits: [
            { reason: 'REASON_STATIC', ranges: [{ from: String(now.getTime()), to: String(now.getTime() + 1) }] },
          ],
        },
      ],
    })
    const time = jest
      .spyOn(clock, 'timeStampNow')
      .mockReturnValueOnce(now.getTime() as clock.TimeStamp)
      .mockReturnValue((now.getTime() + 1) as clock.TimeStamp)
    const result = precomputeConfiguration(rules({ first: timedFlag, second: timedFlag }), context)
    expect(time).toHaveBeenCalledTimes(1)
    expect(Object.keys(result.precomputed!.response.data.attributes.flags)).toEqual(['first', 'second'])
  })

  it.each(['disabled', 'immediate', 'future_experiments_only'] as const)(
    'acknowledges %s experimentation opt-out',
    (mode) => {
      const subject = { ...context, dd_experimentation_opt_out_at: '2026-10-01T08:00:00.123456789-04:00' }
      const experiment = (activation: string) =>
        flag({
          variations: [{ booleanValue: true }, { keyStringIndex: 1, booleanValue: false }],
          allocations: [
            {
              key: 'experiment',
              logExposureEvent: true,
              randomizationActivatedAt: activation,
              splits: [{ reason: 'REASON_STATIC' }],
            },
            { key: 'ordinary', splits: [{ variationIndex: 1, reason: 'REASON_DEFAULT' }] },
          ],
        })
      const input = rules({
        before: experiment('2026-10-01T12:00:00.123456788Z'),
        at: experiment('2026-10-01T12:00:00.123456789Z'),
      })
      const result = roundTrip(precomputeConfiguration(input, subject, { experimentationOptOutMode: mode }))
      for (const key of ['before', 'at']) {
        const expected = mode === 'disabled' || (mode === 'future_experiments_only' && key === 'before')
        expect(evaluate(result, 'boolean', key, !expected, subject, undefined, mode)).toMatchObject({ value: expected })
        expect(evaluate(result, 'boolean', key, !expected, subject, undefined, mode).errorCode).toBeUndefined()
      }
      expect(result.precomputed!.response.data.attributes.evaluation_options).toEqual(
        mode === 'disabled'
          ? undefined
          : mode === 'immediate'
            ? { experimentation_opt_out: true }
            : {
                experimentation_opt_out_mode: mode,
                dd_experimentation_opt_out_at: '2026-10-01T12:00:00.123456789Z',
              }
      )
      if (mode !== 'disabled')
        expect(evaluate(result, 'boolean', 'at', false, subject).errorCode).toBe('INVALID_CONTEXT')
    }
  )

  it('runs sanitized diagnostics after evaluation, without leaking source values or changing neighboring assignments', () => {
    const input = rules({ bad: flag({ minimumFeatureLevel: 1 }), good: flag() })
    const onEvaluationError = jest.fn(() => {
      input.rules!.response.flags.good.variations[0].value = { case: 'booleanValue', value: false }
    })
    const result = precomputeConfiguration(input, context, { onEvaluationError })
    expect(evaluate(result, 'boolean', 'good', false, context).value).toBe(true)
    expect(onEvaluationError.mock.calls).toEqual([[{ flagKey: 'bad', errorCode: 'PARSE_ERROR' }]])
    expect(() =>
      precomputeConfiguration(input, context, {
        onEvaluationError: () => {
          throw new Error('callback')
        },
      })
    ).toThrow('callback')
  })

  it('retains hostile flag and context keys as own data properties', () => {
    const subject = JSON.parse('{"__proto__":{"x":1},"targetingKey":"subject"}')
    const input = rules()
    const prepared = input.rules!.response
    prepared.flags = Object.fromEntries(
      ['__proto__', 'constructor', 'toString'].map((key) => [key, prepared.flags.flag])
    )
    const result = roundTrip(precomputeConfiguration(input, subject))
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(evaluate(result, 'boolean', key, false, subject).value).toBe(true)
    }
    expect(Object.getPrototypeOf(result.precomputed?.context)).toBe(Object.prototype)
  })

  it.each([undefined, null, {}, { rulesError: 'bad wire' }, { rules: { response: {} } }])(
    'rejects missing/malformed rules input %j',
    (input) => {
      expect(() => precomputeConfiguration(input as FlagsConfiguration, context)).toThrow(ConfigurationPrecomputeError)
      expect(() => precomputeConfiguration(input as FlagsConfiguration, context)).toThrow(
        expect.objectContaining({ code: 'invalid_configuration' })
      )
    }
  )

  it.each([null, [], { experimentationOptOutMode: 'unknown' }, { onEvaluationError: true }])(
    'rejects invalid options %j',
    (options) => {
      expect(() => precomputeConfiguration(rules(), context, options as PrecomputeConfigurationOptions)).toThrow(
        expect.objectContaining({ code: 'invalid_options' })
      )
    }
  )

  it.each([
    null,
    [],
    { targetingKey: 1 },
    { field: undefined },
    { field: Number.NaN },
    { field: new Date() },
    { field: BigInt(1) },
  ])('rejects nonportable context %#', (subject) => {
    expect(() => precomputeConfiguration(rules(), subject as unknown as EvaluationContext)).toThrow(
      expect.objectContaining({ code: 'invalid_context' })
    )
  })

  it('rejects circular or unreadable contexts without exposing their contents', () => {
    const circular: EvaluationContext = {}
    circular.self = circular
    const unreadable = {
      get targetingKey(): string {
        throw new Error('secret context')
      },
    }
    for (const subject of [circular, unreadable]) {
      expect(() => precomputeConfiguration(rules(), subject)).toThrow(
        expect.objectContaining({ code: 'invalid_context' })
      )
      expect(() => precomputeConfiguration(rules(), subject)).not.toThrow('secret context')
    }
  })

  it('only validates opt-out timestamps when opt-out is enabled', () => {
    const subject = { ...context, dd_experimentation_opt_out_at: 'invalid' }
    expect(() => precomputeConfiguration(rules(), subject)).not.toThrow()
    expect(() => precomputeConfiguration(rules(), subject, { experimentationOptOutMode: 'immediate' })).toThrow(
      expect.objectContaining({ code: 'invalid_context' })
    )
  })
})
