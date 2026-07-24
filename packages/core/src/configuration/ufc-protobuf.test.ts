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

// Field numbers mirror ufc.proto from dd-source PR #30526 at commit 8ccbeb1fe2696913506fb61d2e7a4598ea5ec449.
function protobufCondition(kind: number, shaHash: string): number[] {
  if (kind === 2) return protobufMessage(2, [])
  if (kind >= 3 && kind <= 6) {
    return protobufMessage(3, [...protobufVarint(1, 0), ...protobufDouble(kind - 1, 1.5)])
  }
  if (kind === 7 || kind === 8) {
    return protobufMessage(4, [...protobufVarint(1, 0), ...protobufVarint(kind - 5, 0)])
  }
  if (kind === 9 || kind === 10) {
    const indexes = protobufMessage(kind - 7, protobufVarint(1, 2))
    return protobufMessage(5, [...protobufVarint(1, 0), ...indexes])
  }
  if (kind === 11 || kind === 12) {
    const hashes = protobufMessage(kind - 8, protobufBytes(1, [...Buffer.from(shaHash, 'hex')]))
    return protobufMessage(6, [...protobufVarint(1, 0), ...protobufBytes(2, [1, 2]), ...hashes])
  }
  if (kind === 13 || kind === 14) {
    return protobufMessage(7, [...protobufVarint(1, 0), ...protobufVarint(2, kind === 13 ? 1 : 0)])
  }
  return protobufMessage(8, [...protobufVarint(1, 0), ...protobufVarint(kind - 13, 0)])
}

function rulesResponse(
  options: {
    conditionKind?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20
    shardAttribute?: boolean
    nonFiniteVariation?: boolean
    integerVariation?: bigint
    variationType?: number
    variationValueFields?: number[]
    timeRanges?: Array<Array<{ from?: number; to?: number }>>
    conditionMessages?: number[][]
    targetingConditionIndex?: number
    includeFallbackAllocation?: boolean
    minimumFeatureLevel?: number
    jsonValue?: string
    observeFullEvaluationData?: boolean
    futureFlagFeatureLevel?: number
    unknownTopLevelCondition?: boolean
    unknownConditionGroup?: 3 | 4 | 5 | 6 | 7 | 8
    futurePartitionKeyFields?: number[]
    futureVariationValueFields?: number[]
    futureTargetingConditionIndex?: number
  } = {}
): string {
  const conditionKind = options.conditionKind ?? 9
  const shaHash = 'b868928fad81eee188461dd76a72ea4279331d77063fa8802fb83c8b2bf6dc45'
  const condition = protobufCondition(conditionKind, shaHash)
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
    ...(options.shardAttribute ? protobufVarint(2, 0) : []),
    ...protobufVarint(3, 100),
  ]
  const partitionKeys = options.timeRanges
    ? options.timeRanges[0].map(() => protobufMessage(1, []))
    : [protobufMessage(2, md5Shard)]
  const splitRanges = options.timeRanges ?? [[{ from: 0, to: 100 }]]
  const splits = splitRanges.map((ranges) => [
    ...ranges.flatMap((range) =>
      protobufMessage(1, [
        ...(range.from === undefined ? [] : protobufVarint(1, range.from)),
        ...(range.to === undefined ? [] : protobufVarint(2, range.to)),
      ])
    ),
    ...protobufVarint(2, 0),
    ...protobufVarint(3, 7),
    ...protobufVarint(4, 1),
  ])
  const allocation = [
    ...protobufString(1, 'allocation'),
    ...protobufVarint(2, options.targetingConditionIndex ?? 0),
    ...partitionKeys.flatMap((partitionKey) => protobufMessage(3, partitionKey)),
    ...splits.flatMap((split) => protobufMessage(4, split)),
    ...protobufVarint(5, 1),
  ]
  const fallbackAllocation = [
    ...protobufString(1, 'fallback'),
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
    ...protobufString(4, 'country'),
    ...protobufString(5, 'on'),
    ...protobufString(5, 'off'),
    ...protobufString(5, 'US'),
    ...protobufString(6, '^US$'),
    ...protobufString(7, '1.2.3'),
    ...(options.jsonValue === undefined ? [] : protobufString(8, options.jsonValue)),
    ...(
      options.conditionMessages ??
      (options.futureFlagFeatureLevel === undefined ? [condition] : [condition, unknownCondition])
    ).flatMap((entry) => protobufMessage(9, entry)),
    ...protobufVarint(10, options.observeFullEvaluationData ? 1 : 0),
  ]
  return Buffer.from(configuration).toString('base64')
}

type RulesResponseOptions = NonNullable<Parameters<typeof rulesResponse>[0]>

function decodeResponse(response: string) {
  return decodeUniversalFlagConfiguration(response)
}

function decodeRules(options: RulesResponseOptions = {}) {
  return decodeResponse(rulesResponse(options))
}

function decodeTestFlag(options: RulesResponseOptions = {}) {
  return decodeRules(options).flags['test-flag']
}

function decodeTestCondition(options: RulesResponseOptions = {}) {
  return decodeTestFlag(options).allocations[0].rules?.[0].conditions[0]
}

function decodeFlagKeys(options: RulesResponseOptions = {}) {
  return Object.keys(decodeRules(options).flags)
}

describe('UFC protobuf decoder', () => {
  it('decodes a rules protobuf', () => {
    expect(decodeRules()).toEqual({
      createdAt: '1970-01-01T00:00:00.000Z',
      format: 'SERVER',
      observeFullEvaluationData: false,
      environment: { name: 'prod' },
      flags: {
        'test-flag': {
          key: 'test-flag',
          enabled: true,
          variationType: 'BOOLEAN',
          variations: { on: { key: 'on', value: true } },
          allocations: [
            {
              key: 'allocation',
              rules: [
                {
                  conditions: [{ operator: 'ONE_OF', attribute: 'country', value: ['US'] }],
                },
              ],
              splits: [
                {
                  variationKey: 'on',
                  shards: [
                    {
                      salt: 'salt',
                      totalShards: 100,
                      hashMode: 'PROTOBUF_V1',
                      ranges: [{ start: 0, end: 100 }],
                    },
                  ],
                  serialId: 7,
                  reason: 'TARGETING_MATCH',
                },
              ],
              doLog: true,
            },
          ],
        },
      },
    })
  })

  it.each(['not base64', 'CA=='])('omits malformed rules response %s', (response) => {
    expect(() => decodeResponse(response)).toThrow()
  })

  it.each(['A=', 'AA=', 'AB=='])('omits rules response with invalid base64 padding %s', (response) => {
    expect(() => decodeResponse(response)).toThrow()
  })

  it('preserves the rules config but omits an allocation targeted by empty ANY', () => {
    expect(decodeTestFlag({ conditionKind: 2 }).allocations).toEqual([])
  })

  it('propagates a false ANY through ALL while preserving another allocation', () => {
    const emptyAny = protobufMessage(2, [])
    const allContainingFalse = protobufMessage(1, protobufVarint(1, 0))
    const flag = decodeTestFlag({
      conditionMessages: [emptyAny, allContainingFalse],
      targetingConditionIndex: 1,
      includeFallbackAllocation: true,
    })

    expect(flag.allocations.map(({ key }) => key)).toEqual(['fallback'])
  })

  it('omits a protobuf containing a non-finite variation value', () => {
    const restored = decodeRules({ nonFiniteVariation: true })

    expect(restored.flags).toEqual({})
  })

  it('decodes a negative int64 variation without requiring runtime BigInt support', () => {
    expect(decodeTestFlag({ integerVariation: BigInt(-42) }).variations.on.value).toBe(-42)
  })

  it('omits an int64 variation outside the JavaScript safe integer range', () => {
    expect(() => decodeRules({ integerVariation: BigInt('9007199254740992') })).toThrow(
      'Protobuf int64 is outside the JavaScript safe integer range'
    )
  })

  it.each([
    [3, 'LT'],
    [4, 'LTE'],
    [5, 'GT'],
    [6, 'GTE'],
  ] as const)('decodes numeric comparator kind %s', (conditionKind, operator) => {
    const condition = decodeTestCondition({ conditionKind })

    expect(condition).toEqual({ operator, attribute: 'country', value: 1.5 })
  })

  it.each([
    [7, 'MATCHES'],
    [8, 'NOT_MATCHES'],
  ] as const)('decodes regex comparator kind %s', (conditionKind, operator) => {
    const condition = decodeTestCondition({ conditionKind })

    expect(condition).toEqual({ operator, attribute: 'country', value: '^US$' })
  })

  it.each([
    [9, 'ONE_OF'],
    [10, 'NOT_ONE_OF'],
  ] as const)('decodes string-membership comparator kind %s', (conditionKind, operator) => {
    const condition = decodeTestCondition({ conditionKind })

    expect(condition).toEqual({ operator, attribute: 'country', value: ['US'] })
  })

  it.each([
    [13, true],
    [14, false],
  ] as const)('decodes attribute-presence comparator kind %s', (conditionKind, value) => {
    const condition = decodeTestCondition({ conditionKind })

    expect(condition).toEqual({ operator: 'IS_NULL', attribute: 'country', value })
  })

  it.each([
    [15, 'SEMVER_EQUAL'],
    [16, 'SEMVER_NOT_EQUAL'],
    [17, 'SEMVER_LT'],
    [18, 'SEMVER_LTE'],
    [19, 'SEMVER_GT'],
    [20, 'SEMVER_GTE'],
  ] as const)('decodes SemVer condition kind %s', (conditionKind, operator) => {
    expect(decodeTestCondition({ conditionKind })).toEqual({
      operator,
      attribute: 'country',
      value: '1.2.3',
    })
  })

  it.each([
    [11, 'ONE_OF_SHA256'],
    [12, 'NOT_ONE_OF_SHA256'],
  ] as const)('decodes SHA-256 condition kind %s', (conditionKind, operator) => {
    expect(decodeTestCondition({ conditionKind })).toMatchObject({
      operator,
      attribute: 'country',
      value: {
        salt: [1, 2],
        hashes: ['b868928fad81eee188461dd76a72ea4279331d77063fa8802fb83c8b2bf6dc45'],
      },
    })
  })

  it('skips a flag requiring a higher feature level without dropping the configuration', () => {
    const restored = decodeRules({ minimumFeatureLevel: 1 })

    expect(restored.environment).toEqual({ name: 'prod' })
    expect(restored.flags).toEqual({})
  })

  it.each([
    ['{"enabled":true}', { enabled: true }],
    ['"scalar"', 'scalar'],
    ['42', 42],
  ])('decodes an interned JSON variation %s', (jsonValue, expected) => {
    expect(decodeTestFlag({ jsonValue }).variations.on.value).toEqual(expected)
  })

  it('rejects a non-finite interned JSON variation', () => {
    const restored = decodeRules({ jsonValue: '1e400' })

    expect(restored.flags).toEqual({})
  })

  it('propagates observeFullEvaluationData', () => {
    const restored = decodeRules({ observeFullEvaluationData: true })

    expect(restored.observeFullEvaluationData).toBe(true)
  })

  it('uses the last protobuf variation oneof field', () => {
    expect(
      decodeTestFlag({
        variationType: 2,
        variationValueFields: [...protobufVarint(5, 1), ...protobufVarint(3, -42)],
      }).variations.on.value
    ).toBe(-42)
  })

  it('accepts a valid numeric variation that overwrites an earlier non-finite value', () => {
    expect(
      decodeTestFlag({
        variationType: 3,
        variationValueFields: [...protobufDouble(4, Number.NaN), ...protobufDouble(4, 2.5)],
      }).variations.on.value
    ).toBe(2.5)
  })

  it('omits a flag whose final numeric variation is non-finite', () => {
    const restored = decodeRules({
      variationType: 3,
      variationValueFields: [...protobufDouble(4, 2.5), ...protobufDouble(4, Number.NaN)],
    })

    expect(restored.flags).toEqual({})
  })

  it('rejects a last variation oneof field that disagrees with the flag type', () => {
    const restored = decodeRules({
      variationType: 4,
      variationValueFields: [...protobufVarint(5, 1), ...protobufVarint(3, -42)],
    })

    expect(restored.flags).toEqual({})
  })

  it('skips a higher-level flag referencing an unknown nested comparator', () => {
    expect(decodeFlagKeys({ futureFlagFeatureLevel: 1 })).toEqual(['test-flag'])
  })

  it.each([1, 0])(
    'retains the valid flag when a feature-level %s flag uses a future partition key',
    (futureFlagFeatureLevel) => {
      expect(
        decodeFlagKeys({
          futureFlagFeatureLevel,
          futureTargetingConditionIndex: 0,
          futurePartitionKeyFields: protobufMessage(99, []),
        })
      ).toEqual(['test-flag'])
    }
  )

  it('omits only a supported flag whose partition key kind is missing', () => {
    expect(
      decodeFlagKeys({
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futurePartitionKeyFields: [],
      })
    ).toEqual(['test-flag'])
  })

  it.each([
    {
      description: 'unknown then known',
      fields: [...protobufMessage(99, []), ...protobufMessage(1, [])],
      expectedFlags: ['test-flag'],
    },
    {
      description: 'known then unknown',
      fields: [...protobufMessage(1, []), ...protobufMessage(99, [])],
      expectedFlags: ['test-flag'],
    },
  ])('rejects a partition key containing unknown oneof data for $description', ({ fields, expectedFlags }) => {
    expect(
      decodeFlagKeys({
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futurePartitionKeyFields: fields,
      })
    ).toEqual(expectedFlags)
  })

  it.each([1, 0])(
    'retains the valid flag when a feature-level %s flag uses a future variation value',
    (futureFlagFeatureLevel) => {
      expect(
        decodeFlagKeys({
          futureFlagFeatureLevel,
          futureTargetingConditionIndex: 0,
          futureVariationValueFields: protobufMessage(99, []),
        })
      ).toEqual(['test-flag'])
    }
  )

  it.each([
    {
      description: 'unknown then known',
      fields: [...protobufMessage(99, []), ...protobufVarint(5, 1)],
      expectedFlags: ['test-flag'],
    },
    {
      description: 'known then unknown',
      fields: [...protobufVarint(5, 1), ...protobufMessage(99, [])],
      expectedFlags: ['test-flag'],
    },
  ])('rejects a variation containing unknown oneof data for $description', ({ fields, expectedFlags }) => {
    expect(
      decodeFlagKeys({
        futureFlagFeatureLevel: 0,
        futureTargetingConditionIndex: 0,
        futureVariationValueFields: fields,
      })
    ).toEqual(expectedFlags)
  })

  it.each([3, 4, 5, 6, 7, 8] as const)(
    'omits only a supported flag referencing an unknown comparator in condition group %s',
    (unknownConditionGroup) => {
      expect(decodeFlagKeys({ futureFlagFeatureLevel: 0, unknownConditionGroup })).toEqual(['test-flag'])
    }
  )

  it('omits only a supported flag referencing an unknown top-level condition', () => {
    expect(decodeFlagKeys({ futureFlagFeatureLevel: 0, unknownTopLevelCondition: true })).toEqual(['test-flag'])
  })

  it('rejects a nested comparator containing unknown oneof data', () => {
    const numeric = protobufMessage(3, [...protobufVarint(1, 0), ...protobufMessage(99, []), ...protobufDouble(2, 1.5)])

    expect(decodeFlagKeys({ conditionMessages: [numeric] })).toEqual([])
  })

  it('accepts a finite numeric comparator that overwrites an earlier non-finite value', () => {
    const numeric = protobufMessage(3, [
      ...protobufVarint(1, 0),
      ...protobufDouble(2, Number.NaN),
      ...protobufDouble(2, 1.5),
    ])
    const condition = decodeTestCondition({ conditionMessages: [numeric] })

    expect(condition).toEqual({ operator: 'LT', attribute: 'country', value: 1.5 })
  })

  it('omits a flag whose final numeric comparator is non-finite', () => {
    const numeric = protobufMessage(3, [
      ...protobufVarint(1, 0),
      ...protobufDouble(2, 1.5),
      ...protobufDouble(2, Number.NaN),
    ])
    expect(decodeRules({ conditionMessages: [numeric] }).flags).toEqual({})
  })

  it('preserves different time ranges for ordered splits', () => {
    const allocations = decodeTestFlag({
      timeRanges: [[{ from: 100, to: 200 }], [{ from: 200, to: 300 }]],
    }).allocations

    expect(allocations).toHaveLength(2)
    expect(allocations.map(({ startAt, endAt }) => [startAt?.getTime(), endAt?.getTime()])).toEqual([
      [100, 200],
      [200, 300],
    ])
  })

  it('intersects multiple time partition dimensions', () => {
    const allocation = decodeTestFlag({
      timeRanges: [
        [
          { from: 100, to: 400 },
          { from: 150, to: 300 },
        ],
      ],
    }).allocations[0]

    expect([allocation.startAt?.getTime(), allocation.endAt?.getTime()]).toEqual([150, 300])
  })

  it('retains an always-nonmatching window for an empty time intersection', () => {
    const allocation = decodeTestFlag({
      timeRanges: [
        [
          { from: 100, to: 200 },
          { from: 300, to: 400 },
        ],
      ],
    }).allocations[0]

    expect([allocation.startAt?.getTime(), allocation.endAt?.getTime()]).toEqual([300, 300])
  })

  it('preserves a non-targeting-key shard attribute', () => {
    expect(decodeTestFlag({ shardAttribute: true }).allocations[0].splits[0].shards[0]).toMatchObject({
      attribute: 'country',
      hashMode: 'PROTOBUF_V1',
    })
  })
})
