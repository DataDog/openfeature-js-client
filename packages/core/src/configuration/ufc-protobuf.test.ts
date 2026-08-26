import type { EvaluationContext, Logger } from '@openfeature/core'
import { evaluateRulesBasedConfiguration } from '../evaluation'
import { evaluateProtobufConfiguration } from '../evaluation/evaluateProtobufConfiguration'
import { MD5Sharder } from '../evaluation/sharders'
import type { TimeStamp } from '../time'
import { decodeUniversalFlagConfiguration } from './ufc-protobuf'

function varint(input: number | bigint): number[] {
  let value = BigInt(input)
  if (value < BigInt(0)) value = BigInt.asUintN(64, value)
  const bytes: number[] = []
  do {
    let byte = Number(value & BigInt(0x7f))
    value >>= BigInt(7)
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return bytes
}

function protobufField(field: number, wireType: number, value: number[]): number[] {
  return [...varint((field << 3) | wireType), ...value]
}

function protobufVarint(field: number, value: number | bigint): number[] {
  return protobufField(field, 0, varint(value))
}

function protobufMessage(field: number, value: number[]): number[] {
  return protobufField(field, 2, [...varint(value.length), ...value])
}

function protobufString(field: number, value: string): number[] {
  return protobufMessage(field, [...Buffer.from(value)])
}

function protobufBytes(field: number, value: number[]): number[] {
  return protobufMessage(field, value)
}

function protobufDouble(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(8)
  new DataView(buffer).setFloat64(0, value, true)
  return protobufField(field, 1, [...new Uint8Array(buffer)])
}

// Field numbers mirror ufc.proto from dd-source PR #70386 at merge commit
// 15f7187d7e8958738af06bae117895ab01ccfc03.
function protobufCondition(
  kind: number,
  shaHashes: string[],
  membershipIndexes: number[],
  attributeIndex = 0
): number[] {
  if (kind === 2) return protobufMessage(2, [])
  if (kind >= 3 && kind <= 6) {
    return protobufMessage(3, [
      ...protobufVarint(1, attributeIndex),
      ...protobufVarint(2, kind - 2),
      ...protobufDouble(3, 1.5),
    ])
  }
  if (kind === 7 || kind === 8) {
    return protobufMessage(4, [
      ...protobufVarint(1, attributeIndex),
      ...protobufVarint(2, 0),
      ...(kind === 8 ? protobufVarint(3, 1) : []),
    ])
  }
  if (kind === 9 || kind === 10) {
    return protobufMessage(5, [
      ...protobufVarint(1, attributeIndex),
      ...membershipIndexes.flatMap((index) => protobufVarint(2, index)),
      ...(kind === 10 ? protobufVarint(3, 1) : []),
    ])
  }
  if (kind === 11 || kind === 12) {
    return protobufMessage(6, [
      ...protobufVarint(1, attributeIndex),
      ...protobufBytes(2, [1, 2]),
      ...shaHashes.flatMap((hash) => protobufBytes(3, [...Buffer.from(hash, 'hex')])),
      ...(kind === 12 ? protobufVarint(4, 1) : []),
    ])
  }
  if (kind === 13 || kind === 14) {
    return protobufMessage(7, [...protobufVarint(1, attributeIndex), ...protobufVarint(2, kind === 13 ? 1 : 0)])
  }
  if (kind >= 15 && kind <= 20) {
    return protobufMessage(8, [
      ...protobufVarint(1, attributeIndex),
      ...protobufVarint(2, kind - 14),
      ...protobufVarint(3, 0),
    ])
  }
  if (kind >= 21 && kind <= 23) {
    return protobufMessage(9, [
      ...protobufVarint(1, attributeIndex),
      ...protobufVarint(2, kind - 20),
      ...protobufVarint(3, 2),
    ])
  }
  return protobufMessage(10, [
    ...protobufVarint(1, attributeIndex),
    ...protobufBytes(2, [1, 2]),
    ...protobufVarint(3, kind - 23),
    ...protobufVarint(4, 2),
    ...protobufBytes(5, [...Buffer.from(shaHashes[0], 'hex')]),
  ])
}

function protobufVersion(value: string): number[] {
  const withoutBuild = value.split('+', 1)[0]
  const prereleaseStart = withoutBuild.indexOf('-')
  const core = prereleaseStart === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseStart)
  const prerelease = prereleaseStart === -1 ? '' : withoutBuild.slice(prereleaseStart + 1)
  return [
    ...core.split('.').flatMap((component) => protobufString(1, component)),
    ...(prerelease ? prerelease.split('.').flatMap((identifier) => protobufString(2, identifier)) : []),
  ]
}

type RulesResponseOptions = {
  conditionKind?:
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10
    | 11
    | 12
    | 13
    | 14
    | 15
    | 16
    | 17
    | 18
    | 19
    | 20
    | 21
    | 22
    | 23
    | 24
    | 25
  shardAttribute?: boolean
  nonFiniteVariation?: boolean
  integerVariation?: bigint
  variationType?: number
  variationValueFields?: number[]
  timeRanges?: Array<Array<{ from?: number | bigint; to?: number | bigint }>>
  splitRanges?: Array<Array<{ from?: number | bigint; to?: number | bigint }>>
  conditionMessages?: number[][]
  targetingConditionIndex?: number
  omitTargetingCondition?: boolean
  includeFallbackAllocation?: boolean
  minimumFeatureLevel?: number
  jsonValue?: string
  observeFullEvaluationData?: boolean
  futureFlagFeatureLevel?: number
  unknownTopLevelCondition?: boolean
  unknownConditionGroup?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
  futurePartitionKeyFields?: number[]
  futureVariationValueFields?: number[]
  unusedVariationValueFields?: number[]
  futureTargetingConditionIndex?: number
  fallbackTargetingConditionIndex?: number
  splitReason?: number
  attributeName?: string
  attributePath?: Array<string | number>
  conditionAttributeIndex?: number
  strings?: string[]
  version?: string
  membershipIndexes?: number[]
  shaHashes?: string[]
}

function rulesResponse(options: RulesResponseOptions = {}): string {
  const conditionKind = options.conditionKind ?? 9
  const shaHashes = options.shaHashes ?? ['b868928fad81eee188461dd76a72ea4279331d77063fa8802fb83c8b2bf6dc45']
  const condition = protobufCondition(
    conditionKind,
    shaHashes,
    options.membershipIndexes ?? [2],
    options.conditionAttributeIndex
  )
  const strings = options.strings ?? ['on', 'off', 'US']
  const attributePath = options.attributePath ?? [options.attributeName ?? 'country']
  const attributePathStrings = attributePath.filter((segment): segment is string => typeof segment === 'string')
  let attributePathStringIndex = strings.length
  const attributePathReference = protobufMessage(
    2,
    attributePath.flatMap((segment) =>
      protobufMessage(
        1,
        typeof segment === 'string' ? protobufVarint(1, attributePathStringIndex++) : protobufVarint(2, segment)
      )
    )
  )
  const targetingKeyReference = protobufMessage(1, [])
  const variation = [
    ...protobufVarint(1, 0),
    ...(options.variationValueFields ??
      (options.nonFiniteVariation
        ? protobufDouble(4, Number.NaN)
        : options.jsonValue !== undefined
          ? protobufVarint(6, 0)
          : options.integerVariation !== undefined
            ? protobufVarint(3, options.integerVariation)
            : protobufVarint(5, 1))),
  ]
  const md5Shard = [
    ...protobufString(1, 'salt'),
    ...protobufVarint(2, options.shardAttribute ? 0 : 1),
    ...protobufVarint(3, 100),
  ]
  const partitionKeys = options.timeRanges
    ? options.timeRanges[0].map(() => protobufMessage(1, []))
    : [protobufMessage(2, md5Shard)]
  const splitRanges = options.splitRanges ?? options.timeRanges ?? [[{ from: 0, to: 100 }]]
  const splits = splitRanges.map((ranges) => [
    ...ranges.flatMap((range) =>
      protobufMessage(1, [
        ...(range.from === undefined ? [] : protobufVarint(1, range.from)),
        ...(range.to === undefined ? [] : protobufVarint(2, range.to)),
      ])
    ),
    ...protobufVarint(2, 0),
    ...protobufVarint(3, 7),
    ...protobufVarint(4, options.splitReason ?? 1),
  ])
  const allocation = [
    ...protobufString(1, 'allocation'),
    ...(options.omitTargetingCondition ? [] : protobufVarint(2, options.targetingConditionIndex ?? 0)),
    ...partitionKeys.flatMap((partitionKey) => protobufMessage(3, partitionKey)),
    ...splits.flatMap((split) => protobufMessage(4, split)),
    ...protobufVarint(5, 1),
  ]
  const fallbackAllocation = [
    ...protobufString(1, 'fallback'),
    ...(options.fallbackTargetingConditionIndex === undefined
      ? []
      : protobufVarint(2, options.fallbackTargetingConditionIndex)),
    ...partitionKeys.flatMap((partitionKey) => protobufMessage(3, partitionKey)),
    ...splits.flatMap((split) => protobufMessage(4, split)),
  ]
  const futureAllocation = [
    ...protobufString(1, 'future-allocation'),
    ...protobufVarint(2, options.futureTargetingConditionIndex ?? 1),
    ...(options.futurePartitionKeyFields === undefined ? partitionKeys : [options.futurePartitionKeyFields]).flatMap(
      (partitionKey) => protobufMessage(3, partitionKey)
    ),
    ...splits.flatMap((split) => protobufMessage(4, split)),
  ]
  const flag = [
    ...protobufVarint(1, options.minimumFeatureLevel ?? 0),
    ...protobufVarint(
      2,
      options.variationType ??
        (options.jsonValue !== undefined
          ? 5
          : options.nonFiniteVariation
            ? 3
            : options.integerVariation !== undefined
              ? 2
              : 4)
    ),
    ...protobufMessage(3, variation),
    ...(options.unusedVariationValueFields === undefined
      ? []
      : protobufMessage(3, [...protobufVarint(1, 1), ...options.unusedVariationValueFields])),
    ...protobufMessage(4, allocation),
    ...(options.includeFallbackAllocation ? protobufMessage(4, fallbackAllocation) : []),
  ]
  const flagEntry = [...protobufString(1, 'test-flag'), ...protobufMessage(2, flag)]
  const futureFlag = [
    ...protobufVarint(1, options.futureFlagFeatureLevel ?? 1),
    ...protobufVarint(2, 4),
    ...protobufMessage(3, [...protobufVarint(1, 0), ...(options.futureVariationValueFields ?? protobufVarint(5, 1))]),
    ...protobufMessage(4, futureAllocation),
  ]
  const futureFlagEntry = [...protobufString(1, 'future-flag'), ...protobufMessage(2, futureFlag)]
  const unknownCondition = options.unknownTopLevelCondition
    ? protobufMessage(99, [])
    : protobufMessage(options.unknownConditionGroup ?? 3, [...protobufVarint(1, 0), ...protobufMessage(99, [])])
  const timestamp = [...protobufVarint(1, 0), ...protobufVarint(2, 0)]
  const configuration = [
    ...protobufMessage(1, timestamp),
    ...protobufString(2, 'prod'),
    ...protobufMessage(3, flagEntry),
    ...(options.futureFlagFeatureLevel === undefined ? [] : protobufMessage(3, futureFlagEntry)),
    ...protobufMessage(4, attributePathReference),
    ...protobufMessage(4, targetingKeyReference),
    ...[...strings, ...attributePathStrings].flatMap((value) => protobufString(5, value)),
    ...protobufString(6, '^US$'),
    ...protobufMessage(7, protobufVersion(options.version ?? '1.2.3')),
    ...(options.jsonValue === undefined ? [] : protobufString(8, options.jsonValue)),
    ...(
      options.conditionMessages ??
      (options.futureFlagFeatureLevel === undefined ? [condition] : [condition, unknownCondition])
    ).flatMap((entry) => protobufMessage(9, entry)),
    ...protobufVarint(10, options.observeFullEvaluationData ? 1 : 0),
  ]
  return Buffer.from(configuration).toString('base64')
}

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function decodeRules(options: RulesResponseOptions = {}) {
  return decodeUniversalFlagConfiguration(rulesResponse(options))
}

function evaluateBoolean(options: RulesResponseOptions, context: EvaluationContext) {
  return evaluateRulesBasedConfiguration(decodeRules(options), 'boolean', 'test-flag', false, context, logger)
}

function evaluateFlag(
  configuration: ReturnType<typeof decodeRules>,
  flagKey: string,
  context: EvaluationContext = { targetingKey: 'user', country: 'US' }
) {
  const variationType = configuration.flags[flagKey]?.variationType
  if (variationType === 1) {
    return evaluateRulesBasedConfiguration(configuration, 'string', flagKey, '', context, logger)
  }
  if (variationType === 2 || variationType === 3) {
    return evaluateRulesBasedConfiguration(configuration, 'number', flagKey, 0, context, logger)
  }
  if (variationType === 5) {
    return evaluateRulesBasedConfiguration(configuration, 'object', flagKey, null, context, logger)
  }
  return evaluateRulesBasedConfiguration(configuration, 'boolean', flagKey, false, context, logger)
}

function expectFlagConfigurationError(
  options: RulesResponseOptions,
  flagKey = 'test-flag',
  context?: EvaluationContext
): void {
  const configuration = decodeRules(options)

  expect(configuration.flags).toHaveProperty(flagKey)
  expect(evaluateFlag(configuration, flagKey, context)).toMatchObject({
    reason: 'ERROR',
    errorCode: 'PARSE_ERROR',
  })
}

function expectFlagConfigurationAccepted(options: RulesResponseOptions, flagKey = 'test-flag'): void {
  const configuration = decodeRules(options)

  expect(configuration.flags).toHaveProperty(flagKey)
  expect(evaluateFlag(configuration, flagKey).errorCode).toBeUndefined()
}

describe('UFC protobuf decoder', () => {
  it('returns the generated protobuf type without converting it to the JSON UFC shape', () => {
    const configuration = decodeRules()
    const flag = configuration.flags['test-flag']

    expect(configuration).toMatchObject({
      $typeName: 'datadog.ffe.flagging.ufc.v1.FlagsConfiguration',
      environmentName: 'prod',
      attributes: [{ kind: { case: 'attributePath' } }, { kind: { case: 'targetingKey' } }],
      strings: ['on', 'off', 'US', 'country'],
      observeFullEvaluationData: false,
    })
    expect(flag).toMatchObject({ variationType: 4, minimumFeatureLevel: 0 })
    expect(flag.allocations[0]).toMatchObject({ targetingConditionIndex: 0, logExposureEvent: true })
    expect(configuration.conditions[0].kind.case).toBe('stringMembership')
  })

  it.each(['not base64', 'CA=='])('rejects malformed rules response %s', (response) => {
    expect(() => decodeUniversalFlagConfiguration(response)).toThrow()
  })

  it('evaluates the generated protobuf directly', () => {
    expect(evaluateBoolean({}, { targetingKey: 'user', country: 'US' })).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    })
  })

  it.each(['constructor', '__proto__'])('treats inherited protobuf flag key %s as missing', (flagKey) => {
    expect(
      evaluateRulesBasedConfiguration(decodeRules(), 'boolean', flagKey, false, { targetingKey: 'user' }, logger)
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    })
  })

  it.each([
    [3, 1],
    [4, 1.5],
    [5, 2],
    [6, 1.5],
    [7, 'US'],
    [8, 'CA'],
    [9, 'US'],
    [10, 'CA'],
    [11, 'US'],
    [12, 'CA'],
    [13, undefined],
    [14, 'US'],
    [15, '1.2.3'],
    [16, '2.0.0'],
    [17, '1.0.0'],
    [18, '1.2.3'],
    [19, '2.0.0'],
    [20, '1.2.3'],
    [21, 'USA'],
    [22, 'CAUS'],
    [23, 'xUSy'],
    [24, 'USA'],
    [25, 'CAUS'],
  ] as const)('evaluates condition kind %s from interned protobuf data', (conditionKind, country) => {
    expect(
      evaluateBoolean({ conditionKind }, { targetingKey: 'user', ...(country === undefined ? {} : { country }) }).value
    ).toBe(true)
  })

  it.each([
    [3, [1]],
    [3, true],
    [7, ['US']],
    [8, {}],
    [9, ['US']],
    [10, {}],
    [11, ['US']],
    [12, {}],
    [15, ['1.2.3']],
  ] as const)('does not coerce unsupported context value for condition kind %s', (conditionKind, country) => {
    expect(evaluateBoolean({ conditionKind }, { targetingKey: 'user', country } as EvaluationContext)).toMatchObject({
      value: false,
      reason: 'DEFAULT',
    })
  })

  it.each([
    ['a bigint', BigInt(42), '42'],
    ['a Date', new Date('2026-01-01T00:00:00.000Z'), String(new Date('2026-01-01T00:00:00.000Z'))],
    ['a custom scalar-like object', { toString: () => 'custom' }, 'custom'],
  ] as const)('coerces %s for string comparison', (_description, country, expected) => {
    expect(
      evaluateBoolean({ conditionKind: 9, strings: ['on', 'off', expected] }, {
        targetingKey: 'user',
        country,
      } as EvaluationContext)
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it.each([
    ['positive infinity', Number.POSITIVE_INFINITY, true],
    ['a string that overflows to positive infinity', '1e400', true],
    ['NaN', Number.NaN, false],
  ] as const)('uses JavaScript numeric comparison semantics for %s', (_description, country, matches) => {
    expect(evaluateBoolean({ conditionKind: 5 }, { targetingKey: 'user', country })).toMatchObject({
      value: matches,
      reason: matches ? 'TARGETING_MATCH' : 'DEFAULT',
    })
  })

  it.each(['constructor', '__proto__'])('does not match an inherited condition attribute named %s', (attributeName) => {
    expect(evaluateBoolean({ conditionKind: 14, attributeName }, { targetingKey: 'user' })).toMatchObject({
      value: false,
      reason: 'DEFAULT',
    })
  })

  it('evaluates a condition against an explicit targeting-key reference', () => {
    expect(evaluateBoolean({ conditionAttributeIndex: 1 }, { targetingKey: 'US', country: 'CA' })).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
    })
  })

  it('traverses nested object and array attribute paths', () => {
    expect(
      evaluateBoolean(
        { attributePath: ['profile', 'groups', 0, 'country'] },
        { targetingKey: 'user', profile: { groups: [{ country: 'US' }] } }
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it('does not traverse inherited properties in an attribute path', () => {
    expect(
      evaluateBoolean(
        { conditionKind: 14, attributePath: ['profile', 'constructor'] },
        { targetingKey: 'user', profile: {} }
      )
    ).toMatchObject({ value: false, reason: 'DEFAULT' })
  })

  it('does not traverse inherited array elements in an attribute path', () => {
    const groups: EvaluationContext[] = []
    Object.setPrototypeOf(groups, { 0: { country: 'US' } })

    expect(
      evaluateBoolean(
        { attributePath: ['profile', 'groups', 0, 'country'] },
        { targetingKey: 'user', profile: { groups } }
      )
    ).toMatchObject({ value: false, reason: 'DEFAULT' })
  })

  it('does not match a missing nested attribute path', () => {
    expect(
      evaluateBoolean({ attributePath: ['profile', 'country'] }, { targetingKey: 'user', profile: {} })
    ).toMatchObject({ value: false, reason: 'DEFAULT' })
  })

  it('reports an attribute path that does not start with an object key', () => {
    expectFlagConfigurationError({ attributePath: [0] })
  })

  it('reports an empty attribute path', () => {
    expectFlagConfigurationError({ attributePath: [] })
  })

  it.each([
    ['an absent id', { targetingKey: 'US' }, true],
    ['a null id', { targetingKey: 'US', id: null }, true],
    ['a present non-matching id', { targetingKey: 'US', id: 'CA' }, false],
    ['a present matching id', { targetingKey: 'CA', id: 'US' }, true],
  ] as const)('uses the compiler-defined targeting-key fallback for %s', (_description, context, value) => {
    const conditionMessages = [
      protobufCondition(9, [], [2], 0),
      protobufCondition(9, [], [2], 1),
      protobufCondition(13, [], [], 0),
      protobufMessage(1, [...protobufVarint(1, 2), ...protobufVarint(1, 1)]),
      protobufCondition(14, [], [], 0),
      protobufMessage(1, [...protobufVarint(1, 4), ...protobufVarint(1, 0)]),
      protobufMessage(2, [...protobufVarint(1, 3), ...protobufVarint(1, 5)]),
    ]

    expect(
      evaluateBoolean({ attributeName: 'id', conditionMessages, targetingConditionIndex: 6 }, context)
    ).toMatchObject({ value, reason: value ? 'TARGETING_MATCH' : 'DEFAULT' })
  })

  it('compares configured version components above uint64 without precision loss', () => {
    expect(
      evaluateBoolean(
        { conditionKind: 15, version: '18446744073709551616.0.0' },
        { targetingKey: 'user', country: '18446744073709551616.0.0' }
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it('matches a context version component above uint64', () => {
    expect(
      evaluateBoolean(
        { conditionKind: 15, version: '18446744073709551616.0.0' },
        { targetingKey: 'user', country: '18446744073709551616.0.0' }
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it.each([
    ['1', '1.0.0'],
    ['1.2', '1.2.0'],
    ['1.2.0.0', '1.2'],
  ])('treats missing version components as zero: %s == %s', (configured, actual) => {
    expect(
      evaluateBoolean({ conditionKind: 15, version: configured }, { targetingKey: 'user', country: actual })
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it('does not hash a partial UTF-8 code point for prefix and suffix comparisons', () => {
    expect(evaluateBoolean({ conditionKind: 24 }, { targetingKey: 'user', country: '😀US' })).toMatchObject({
      value: false,
      reason: 'DEFAULT',
    })
    expect(evaluateBoolean({ conditionKind: 25 }, { targetingKey: 'user', country: 'US😀' })).toMatchObject({
      value: false,
      reason: 'DEFAULT',
    })
  })

  it.each([
    [9, true, 'TARGETING_MATCH'],
    [10, false, 'DEFAULT'],
  ] as const)('evaluates unsorted string membership values for condition kind %s', (conditionKind, value, reason) => {
    expect(
      evaluateBoolean({ conditionKind, membershipIndexes: [1, 2] }, { targetingKey: 'user', country: 'US' })
    ).toMatchObject({ value, reason })
  })

  it('uses Go UTF-8 ordering for string membership values', () => {
    const configuration = decodeRules({
      conditionKind: 9,
      strings: ['on', 'off', '\ue000', '😀'],
      membershipIndexes: [2, 3],
    })

    for (const country of ['\ue000', '😀']) {
      expect(
        evaluateRulesBasedConfiguration(
          configuration,
          'boolean',
          'test-flag',
          false,
          { targetingKey: 'user', country },
          logger
        )
      ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
    }
  })

  it.each([
    [11, true, 'TARGETING_MATCH'],
    [12, false, 'DEFAULT'],
  ] as const)('evaluates unsorted SHA-256 hashes for condition kind %s', (conditionKind, value, reason) => {
    expect(
      evaluateBoolean(
        {
          conditionKind,
          shaHashes: [
            'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            'b868928fad81eee188461dd76a72ea4279331d77063fa8802fb83c8b2bf6dc45',
          ],
        },
        { targetingKey: 'user', country: 'US' }
      )
    ).toMatchObject({ value, reason })
  })

  it.each([
    [11, true, 'TARGETING_MATCH'],
    [12, false, 'DEFAULT'],
  ] as const)('ignores an unrelated SHA-256 hash length for condition kind %s', (conditionKind, value, reason) => {
    expect(
      evaluateBoolean(
        {
          conditionKind,
          shaHashes: ['00', 'b868928fad81eee188461dd76a72ea4279331d77063fa8802fb83c8b2bf6dc45'],
        },
        { targetingKey: 'user', country: 'US' }
      )
    ).toMatchObject({ value, reason })
  })

  it.each([
    [11, false, 'DEFAULT'],
    [12, true, 'TARGETING_MATCH'],
  ] as const)('does not match a malformed SHA-256 hash for condition kind %s', (conditionKind, value, reason) => {
    expect(
      evaluateBoolean({ conditionKind, shaHashes: ['00'] }, { targetingKey: 'user', country: 'US' })
    ).toMatchObject({ value, reason })
  })

  it('lazily compiles each regex once per configuration', () => {
    const configuration = decodeRules({ conditionKind: 7 })
    const regexes = configuration.regexes
    let reads = 0
    configuration.regexes = new Proxy(regexes, {
      get(target, property, receiver) {
        if (property === '0') reads++
        return Reflect.get(target, property, receiver)
      },
    })

    expect(evaluateFlag(configuration, 'test-flag').value).toBe(true)
    expect(evaluateFlag(configuration, 'test-flag').value).toBe(true)
    expect(reads).toBe(1)
  })

  it('lazily parses each JSON variation once per configuration', () => {
    const configuration = decodeRules({ jsonValue: '{"enabled":true}' })
    const jsonStrings = configuration.jsonStrings
    let reads = 0
    configuration.jsonStrings = new Proxy(jsonStrings, {
      get(target, property, receiver) {
        if (property === '0') reads++
        return Reflect.get(target, property, receiver)
      },
    })

    expect(evaluateFlag(configuration, 'test-flag').value).toEqual({ enabled: true })
    expect(evaluateFlag(configuration, 'test-flag').value).toEqual({ enabled: true })
    expect(reads).toBe(1)
  })

  it('preserves empty ANY semantics without rewriting allocations', () => {
    const configuration = decodeRules({ conditionKind: 2 })

    expect(configuration.flags['test-flag'].allocations).toHaveLength(1)
    expect(
      evaluateRulesBasedConfiguration(configuration, 'boolean', 'test-flag', false, { targetingKey: 'user' }, logger)
    ).toMatchObject({ value: false, reason: 'DEFAULT' })
  })

  it('uses a fallback allocation when an ALL contains an empty ANY', () => {
    const emptyAny = protobufMessage(2, [])
    const allContainingFalse = protobufMessage(1, protobufVarint(1, 0))
    const result = evaluateBoolean(
      {
        conditionMessages: [emptyAny, allContainingFalse],
        targetingConditionIndex: 1,
        includeFallbackAllocation: true,
      },
      { targetingKey: 'user' }
    )

    expect(result).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
    expect(result.flagMetadata).toMatchObject({ allocationKey: 'fallback' })
  })

  it('reports a composite condition that does not reference a preceding condition', () => {
    const allWithForwardReference = protobufMessage(1, protobufVarint(1, 1))
    const emptyAll = protobufMessage(1, [])

    expectFlagConfigurationError({ conditionMessages: [allWithForwardReference, emptyAll] })
  })

  it('evaluates each reachable condition once', () => {
    const conditionMessages = [protobufCondition(9, [], [2])]
    for (let index = 1; index <= 8; index++) {
      const child = index - 1
      conditionMessages.push(protobufMessage(1, [...protobufVarint(1, child), ...protobufVarint(1, child)]))
    }
    const configuration = decodeRules({
      conditionMessages,
      targetingConditionIndex: conditionMessages.length - 1,
    })
    let reads = 0
    configuration.conditions = new Proxy(configuration.conditions, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++
        return Reflect.get(target, property, receiver)
      },
    })

    expect(evaluateFlag(configuration, 'test-flag').value).toBe(true)
    expect(reads).toBe(conditionMessages.length)
  })

  it('retains direct protobuf variation values and evaluates JSON scalars', () => {
    const configuration = decodeRules({ jsonValue: '"scalar"' })
    const variation = configuration.flags['test-flag'].variations[0]

    expect(variation.value).toEqual({ case: 'jsonStringIndex', value: 0 })
    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'object',
        'test-flag',
        null,
        { targetingKey: 'user', country: 'US' },
        logger
      ).value
    ).toBe('scalar')
  })

  it.each([
    [{ minimumFeatureLevel: 1 }, 'test-flag', 'Flag requires an unsupported feature level'],
    [{ minimumFeatureLevel: 4096 }, 'test-flag', 'Flag requires an unsupported feature level'],
    [{ nonFiniteVariation: true }, 'test-flag', 'Numeric variation value is not finite'],
    [{ jsonValue: '1e400' }, 'test-flag', 'JSON variation value is invalid'],
    [{ futureFlagFeatureLevel: 1 }, 'future-flag', 'Flag requires an unsupported feature level'],
  ] as const)('preserves an invalid flag and reports its configuration error', (options, flagKey, errorMessage) => {
    const configuration = decodeRules(options)

    expect(configuration.flags).toHaveProperty(flagKey)
    expect(evaluateFlag(configuration, flagKey)).toMatchObject({
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage,
    })
  })

  it.each([6, 4096])('does not include unsupported variation type %s in the error message', (variationType) => {
    expect(evaluateFlag(decodeRules({ variationType }), 'test-flag')).toMatchObject({
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Unsupported variation type',
    })
  })

  it.each([1, 4096])('does not include invalid variation index %s in the error message', (variationIndex) => {
    const configuration = decodeRules()
    configuration.flags['test-flag'].allocations[0].splits[0].variationIndex = variationIndex

    expect(evaluateFlag(configuration, 'test-flag')).toMatchObject({
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Invalid split variation index',
    })
  })

  it('preserves an int64 variation that cannot be represented as an OpenFeature number', () => {
    const integerVariation = BigInt('9007199254740993')
    const configuration = decodeRules({ integerVariation })

    expect(BigInt(Number(integerVariation))).not.toBe(integerVariation)
    expect(configuration.flags['test-flag'].variations[0].value).toEqual({
      case: 'integerValue',
      value: integerVariation,
    })
    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'number',
        'test-flag',
        0,
        { targetingKey: 'user', country: 'US' },
        logger
      )
    ).toMatchObject({
      value: 0,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Integer variation value cannot be represented safely as a JavaScript number',
    })
  })

  it('keeps a negative int64 variation as protobuf and evaluates it as a number', () => {
    const configuration = decodeRules({ integerVariation: BigInt(-42) })

    expect(configuration.flags['test-flag'].variations[0].value).toEqual({
      case: 'integerValue',
      value: BigInt(-42),
    })
    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'number',
        'test-flag',
        0,
        { targetingKey: 'user', country: 'US' },
        logger
      ).value
    ).toBe(-42)
  })

  it('uses the last protobuf variation oneof field', () => {
    const variation = decodeRules({
      variationType: 2,
      variationValueFields: [...protobufVarint(5, 1), ...protobufVarint(3, -42)],
    }).flags['test-flag'].variations[0]

    expect(variation.value).toEqual({ case: 'integerValue', value: BigInt(-42) })
  })

  it('does not validate variations or allocations that evaluation does not reach', () => {
    const configuration = decodeRules({
      unusedVariationValueFields: protobufVarint(3, 42),
      includeFallbackAllocation: true,
      fallbackTargetingConditionIndex: 99,
    })

    expect(configuration.flags['test-flag'].variations).toHaveLength(2)
    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        'test-flag',
        false,
        { targetingKey: 'user', country: 'US' },
        logger
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it('accepts a finite numeric variation that overwrites an earlier non-finite value', () => {
    expect(
      Object.keys(
        decodeRules({
          variationType: 3,
          variationValueFields: [...protobufDouble(4, Number.NaN), ...protobufDouble(4, 2.5)],
        }).flags
      )
    ).toEqual(['test-flag'])
  })

  it('reports a flag whose final numeric variation is non-finite', () => {
    expectFlagConfigurationError({
      variationType: 3,
      variationValueFields: [...protobufDouble(4, 2.5), ...protobufDouble(4, Number.NaN)],
    })
  })

  it('reports a flag whose final variation oneof disagrees with its variation type', () => {
    expectFlagConfigurationError({
      variationType: 4,
      variationValueFields: [...protobufVarint(5, 1), ...protobufVarint(3, -42)],
    })
  })

  it.each([
    ['{"enabled":true}', { enabled: true }],
    ['"scalar"', 'scalar'],
    ['42', 42],
  ])('evaluates interned JSON variation %s', (jsonValue, expected) => {
    const configuration = decodeRules({ jsonValue })

    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'object',
        'test-flag',
        null,
        { targetingKey: 'user', country: 'US' },
        logger
      ).value
    ).toEqual(expected)
  })

  it.each([
    { fields: [...protobufMessage(99, []), ...protobufMessage(1, [])] },
    { fields: [...protobufMessage(1, []), ...protobufMessage(99, [])] },
  ])('ignores an unknown partition-key field', ({ fields }) => {
    expectFlagConfigurationAccepted(
      {
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futurePartitionKeyFields: fields,
      },
      'future-flag'
    )
  })

  it.each([
    [3, 1],
    [8, '1.2.3'],
    [9, 'US'],
    [10, 'US'],
  ] as const)(
    'reports a supported flag referencing an unspecified condition comparator in group %s',
    (unknownConditionGroup, country) => {
      expectFlagConfigurationError({ futureFlagFeatureLevel: 0, unknownConditionGroup }, 'future-flag', {
        targetingKey: 'user',
        country,
      } as EvaluationContext)
    }
  )

  it.each([
    [3, [...protobufVarint(1, 0), ...protobufVarint(2, 99), ...protobufDouble(3, 1.5)], 1],
    [8, [...protobufVarint(1, 0), ...protobufVarint(2, 99), ...protobufVarint(3, 0)], '1.2.3'],
    [9, [...protobufVarint(1, 0), ...protobufVarint(2, 99), ...protobufVarint(3, 2)], 'US'],
    [10, [...protobufVarint(1, 0), ...protobufBytes(2, []), ...protobufVarint(3, 99)], 'US'],
  ])('reports an unknown enum value in condition group %s', (group, fields, country) => {
    expectFlagConfigurationError({ conditionMessages: [protobufMessage(group, fields)] }, 'test-flag', {
      targetingKey: 'user',
      country,
    } as EvaluationContext)
  })

  it.each([4, 5, 6, 7] as const)('ignores an unknown field in condition group %s', (unknownConditionGroup) => {
    expectFlagConfigurationAccepted({ futureFlagFeatureLevel: 0, unknownConditionGroup }, 'future-flag')
  })

  it.each([0, 1])('reports a feature-level %s flag that uses a future variation value', (futureFlagFeatureLevel) => {
    expectFlagConfigurationError(
      {
        futureFlagFeatureLevel,
        futureTargetingConditionIndex: 0,
        futureVariationValueFields: protobufMessage(99, []),
      },
      'future-flag'
    )
  })

  it.each([
    { fields: [...protobufMessage(99, []), ...protobufVarint(5, 1)] },
    { fields: [...protobufVarint(5, 1), ...protobufMessage(99, [])] },
  ])('ignores unknown variation fields alongside a known value', ({ fields }) => {
    expectFlagConfigurationAccepted(
      {
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futureVariationValueFields: fields,
      },
      'future-flag'
    )
  })

  it('returns UNKNOWN for an unknown split reason', () => {
    expect(evaluateBoolean({ splitReason: 99 }, { targetingKey: 'user', country: 'US' })).toMatchObject({
      value: true,
      reason: 'UNKNOWN',
    })
  })

  it('reports a supported flag whose partition key kind is missing', () => {
    expectFlagConfigurationError(
      {
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futurePartitionKeyFields: [],
      },
      'future-flag'
    )
  })

  it('reports a supported flag referencing an unknown top-level condition', () => {
    expectFlagConfigurationError({ futureFlagFeatureLevel: 0, unknownTopLevelCondition: true }, 'future-flag')
  })

  it('ignores unknown data alongside a known nested comparator', () => {
    const numeric = protobufMessage(3, [
      ...protobufVarint(1, 0),
      ...protobufVarint(2, 1),
      ...protobufMessage(99, []),
      ...protobufDouble(3, 1.5),
    ])

    expectFlagConfigurationAccepted({ conditionMessages: [numeric] })
  })

  it('accepts a finite numeric comparator that overwrites an earlier NaN value', () => {
    const numeric = protobufMessage(3, [
      ...protobufVarint(1, 0),
      ...protobufVarint(2, 1),
      ...protobufDouble(3, Number.NaN),
      ...protobufDouble(3, 1.5),
    ])

    expect(evaluateBoolean({ conditionMessages: [numeric] }, { targetingKey: 'user', country: 1 }).value).toBe(true)
  })

  it('reports a flag whose final numeric comparator is NaN', () => {
    const numeric = protobufMessage(3, [
      ...protobufVarint(1, 0),
      ...protobufVarint(2, 1),
      ...protobufDouble(3, 1.5),
      ...protobufDouble(3, Number.NaN),
    ])

    expectFlagConfigurationError({ conditionMessages: [numeric] })
  })

  it.each([
    [1, Number.POSITIVE_INFINITY, 1, true, Number.POSITIVE_INFINITY, false],
    [3, Number.NEGATIVE_INFINITY, 1, true, Number.NEGATIVE_INFINITY, false],
  ])(
    'supports numeric comparator %s with an infinite comparand',
    (comparator, comparand, finiteValue, finiteResult, infiniteValue, infiniteResult) => {
      const numeric = protobufMessage(3, [
        ...protobufVarint(1, 0),
        ...protobufVarint(2, comparator),
        ...protobufDouble(3, comparand),
      ])

      expect(
        evaluateBoolean({ conditionMessages: [numeric] }, { targetingKey: 'user', country: finiteValue }).value
      ).toBe(finiteResult)
      expect(
        evaluateBoolean({ conditionMessages: [numeric] }, { targetingKey: 'user', country: infiniteValue }).value
      ).toBe(infiniteResult)
    }
  )

  it('preserves composite time ranges in the protobuf representation', () => {
    const allocation = decodeRules({
      timeRanges: [
        [
          { from: 100, to: 400 },
          { from: 150, to: 300 },
        ],
      ],
    }).flags['test-flag'].allocations[0]

    expect(allocation.partitionKey.map((partition) => partition.kind.case)).toEqual(['time', 'time'])
    expect(allocation.splits[0].ranges).toMatchObject([
      { from: BigInt(100), to: BigInt(400) },
      { from: BigInt(150), to: BigInt(300) },
    ])
  })

  it('preserves ordered split time ranges', () => {
    const splits = decodeRules({
      timeRanges: [[{ from: 100, to: 200 }], [{ from: 200, to: 300 }]],
    }).flags['test-flag'].allocations[0].splits

    expect(splits.map((split) => split.ranges[0])).toMatchObject([
      { from: BigInt(100), to: BigInt(200) },
      { from: BigInt(200), to: BigInt(300) },
    ])
  })

  it('preserves an empty composite time intersection for direct evaluation', () => {
    const ranges = decodeRules({
      timeRanges: [
        [
          { from: 100, to: 200 },
          { from: 300, to: 400 },
        ],
      ],
    }).flags['test-flag'].allocations[0].splits[0].ranges

    expect(ranges).toMatchObject([
      { from: BigInt(100), to: BigInt(200) },
      { from: BigInt(300), to: BigInt(400) },
    ])
  })

  it('treats an omitted partition range bound as unbounded', () => {
    const configuration = decodeRules({ timeRanges: [[{ to: 0 }]] })

    expect(
      evaluateProtobufConfiguration(
        configuration,
        'boolean',
        'test-flag',
        false,
        { targetingKey: 'user', country: 'US' },
        logger,
        -1 as TimeStamp
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it.each([
    [{ from: BigInt('9007199254740993') }, false, 'DEFAULT'],
    [{ to: BigInt('9007199254740993') }, true, 'TARGETING_MATCH'],
  ] as const)('compares a time coordinate with an exact BigInt range bound', (range, value, reason) => {
    const configuration = decodeRules({ timeRanges: [[range]] })

    expect(
      evaluateProtobufConfiguration(
        configuration,
        'boolean',
        'test-flag',
        false,
        { targetingKey: 'user', country: 'US' },
        logger,
        (Number.MAX_SAFE_INTEGER + 1) as TimeStamp
      )
    ).toMatchObject({ value, reason })
  })

  it('evaluates a shard using its protobuf attribute index without requiring a targeting key', () => {
    expect(evaluateBoolean({ shardAttribute: true }, { country: 'US' })).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
    })
  })

  it.each(['constructor', '__proto__'])(
    'does not partition on an inherited context attribute named %s',
    (attributeName) => {
      expect(
        evaluateBoolean({ shardAttribute: true, attributeName, omitTargetingCondition: true }, { targetingKey: 'user' })
      ).toMatchObject({
        value: false,
        reason: 'ERROR',
        errorCode: 'INVALID_CONTEXT',
      })
    }
  )

  it('rejects a composite partition attribute', () => {
    expect(
      evaluateBoolean({ shardAttribute: true, omitTargetingCondition: true }, {
        targetingKey: 'user',
        country: {},
      } as EvaluationContext)
    ).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT',
    })
  })

  it('traverses a nested partition attribute path', () => {
    expect(
      evaluateBoolean(
        { shardAttribute: true, attributePath: ['profile', 'country'], omitTargetingCondition: true },
        { profile: { country: 'US' } }
      )
    ).toMatchObject({ value: true, reason: 'TARGETING_MATCH' })
  })

  it('uses an explicit targeting-key partition reference', () => {
    const result = evaluateBoolean({ includeFallbackAllocation: true }, { targetingKey: 'US' })

    expect(result).toMatchObject({ value: true })
    expect(result.flagMetadata).toMatchObject({ allocationKey: 'fallback' })
  })

  it('requires a targeting key for an explicit targeting-key partition reference', () => {
    expect(evaluateBoolean({}, { country: 'US' })).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    })
  })

  it('computes the partition key once across multiple splits', () => {
    const getShard = jest.spyOn(MD5Sharder.prototype, 'getShard')

    expect(
      evaluateBoolean(
        {
          splitRanges: [[{ from: 0, to: 0 }], [{ from: 0, to: 100 }]],
        },
        { targetingKey: 'user', country: 'US' }
      ).value
    ).toBe(true)
    expect(getShard).toHaveBeenCalledTimes(1)

    getShard.mockRestore()
  })

  it('returns a type mismatch before evaluating protobuf allocations', () => {
    expect(
      evaluateRulesBasedConfiguration(
        decodeRules(),
        'string',
        'test-flag',
        'default',
        { targetingKey: 'user', country: 'US' },
        logger
      )
    ).toMatchObject({ value: 'default', reason: 'ERROR', errorCode: 'TYPE_MISMATCH' })
  })

  it.each([
    [1, 'TARGETING_MATCH'],
    [2, 'SPLIT'],
    [3, 'STATIC'],
    [4, 'DEFAULT'],
  ] as const)('uses explicit protobuf reason %s', (splitReason, reason) => {
    expect(evaluateBoolean({ splitReason }, { targetingKey: 'user', country: 'US' }).reason).toBe(reason)
  })

  it('propagates observeFullEvaluationData on the protobuf configuration', () => {
    expect(decodeRules({ observeFullEvaluationData: true }).observeFullEvaluationData).toBe(true)
  })
})
