import { fromJson } from '@bufbuild/protobuf'
import { FlagsConfigurationSchema } from '../configuration/generated/ufc_pb'
import { prepareUniversalFlagConfiguration } from '../configuration/prepared-activation'
import { prepareRulesResponse } from '../configuration/prepared-rules-response'
import { decodeFlagsConfiguration, encodeFlagsConfiguration } from '../configuration/ufc-protobuf'
import { evaluateRulesBasedConfiguration } from './evaluation'
import {
  acknowledgesExperimentationOptOut,
  compareOptOutInstants,
  experimentationOptOutPolicy,
  parseOptOutInstant,
} from './experimentation-opt-out'
import type { UniversalFlagConfigurationV1 } from './ufc-v1'

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const cutoff = '2026-10-01T12:00:00.123456789Z'
const context = { targetingKey: 'subject', dd_experimentation_opt_out_at: cutoff }
const mode = 'future_experiments_only'

function jsonRules(activation?: string | null): UniversalFlagConfigurationV1 {
  return {
    createdAt: '2026-10-20T00:00:00Z',
    format: 'SERVER',
    environment: { name: 'test' },
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
        allocations: [
          {
            key: 'experiment',
            doLog: true,
            randomizationActivatedAt: activation as string | undefined,
            splits: [{ variationKey: 'on', shards: [] }],
          },
          { key: 'ordinary', doLog: false, splits: [{ variationKey: 'off', shards: [] }] },
        ],
      },
    },
  }
}

function protobufRules(activation?: string | null) {
  // Exercise field 6 through actual protobuf encoding and decoding.
  return decodeFlagsConfiguration(encodeFlagsConfiguration(rawProtobufRules(activation)))
}

function rawProtobufRules(activation?: string | null) {
  return fromJson(FlagsConfigurationSchema, {
    strings: ['on', 'off'],
    flags: {
      flag: {
        variationType: 'VARIATION_TYPE_BOOLEAN',
        variations: [
          { keyStringIndex: 0, booleanValue: true },
          { keyStringIndex: 1, booleanValue: false },
        ],
        allocations: [
          {
            key: 'experiment',
            logExposureEvent: true,
            randomizationActivatedAt: activation ?? null,
            splits: [{ variationIndex: 0, reason: 'REASON_STATIC' }],
          },
          { key: 'ordinary', logExposureEvent: false, splits: [{ variationIndex: 1, reason: 'REASON_STATIC' }] },
        ],
      },
    },
  })
}

describe.each([
  ['JSON', jsonRules],
  ['protobuf', protobufRules],
] as const)('%s future opt-out', (_format, rules) => {
  it.each([
    ['2026-10-01T12:00:00.123456788Z', true],
    [cutoff, false],
    ['2026-10-01T12:00:00.123456790Z', false],
    ['2026-10-01T08:00:00.123456789-04:00', false],
    [undefined, false],
    [null, false],
  ])('activation %s returns %s', (activation, expected) => {
    const configuration = rules(activation)
    const result = evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', true, context, logger, mode)
    expect(result.value).toBe(expected)
    expect(result.flagMetadata?.doLog).toBe(expected)
    expect(
      evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        'flag',
        false,
        { targetingKey: 'subject' },
        logger,
        mode
      ).value
    ).toBe(true)
    expect(
      evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', true, context, logger, 'immediate').value
    ).toBe(false)
  })
  it('uses each configuration activation, not its creation time or cached enrollment', () => {
    const older = rules('2026-09-01T00:00:00Z')
    const newer = rules('2026-10-20T00:00:00Z')
    expect(evaluateRulesBasedConfiguration(older, 'boolean', 'flag', false, context, logger, mode).value).toBe(true)
    expect(evaluateRulesBasedConfiguration(newer, 'boolean', 'flag', true, context, logger, mode).value).toBe(false)
  })
})

it.each(['disabled', 'immediate', 'future_experiments_only'] as const)(
  'rejects malformed activation on the affected flag in %s, including unreachable allocations',
  (optOutMode) => {
    const json = jsonRules('garbage')
    json.flags.flag.allocations.reverse()
    json.flags.neighbor = { ...json.flags.flag, key: 'neighbor', allocations: [json.flags.flag.allocations[0]] }
    prepareUniversalFlagConfiguration(json)
    expect(evaluateRulesBasedConfiguration(json, 'boolean', 'flag', false, context, logger, optOutMode).errorCode).toBe(
      'PARSE_ERROR'
    )
    expect(
      evaluateRulesBasedConfiguration(json, 'boolean', 'neighbor', true, context, logger, optOutMode)
    ).toMatchObject({
      value: false,
      reason: 'STATIC',
    })
    const proto = rawProtobufRules(cutoff)
    proto.flags.flag.allocations[0].randomizationActivatedAt!.nanos = 1e9
    proto.flags.neighbor = { ...proto.flags.flag, allocations: [proto.flags.flag.allocations[1]] }
    proto.flags.flag.allocations.reverse()
    prepareRulesResponse(proto)
    expect(
      evaluateRulesBasedConfiguration(proto, 'boolean', 'flag', false, context, logger, optOutMode).errorCode
    ).toBe('PARSE_ERROR')
    expect(evaluateRulesBasedConfiguration(proto, 'boolean', 'neighbor', true, context, logger, optOutMode).value).toBe(
      false
    )
  }
)

describe.each([
  [
    'JSON',
    () => {
      const configuration = jsonRules('2026-09-01T00:00:00.123456788Z')
      return { configuration, prepare: () => prepareUniversalFlagConfiguration(configuration) }
    },
  ],
  [
    'protobuf',
    () => {
      const configuration = rawProtobufRules('2026-09-01T00:00:00.123456788Z')
      return { configuration, prepare: () => prepareRulesResponse(configuration) }
    },
  ],
] as const)('%s activation preparation', (_format, create) => {
  it('reads activation only on preparation, independent of subjects and evaluation modes', () => {
    const { configuration, prepare } = create()
    const allocation = configuration.flags.flag.allocations[0]
    const activation = allocation.randomizationActivatedAt
    const read = jest.fn(() => activation)
    Object.defineProperty(allocation, 'randomizationActivatedAt', { get: read })
    prepare()
    prepare()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockImplementation(() => {
      throw new Error('activation must not be read during evaluation')
    })

    for (const optOutMode of ['disabled', 'immediate', 'future_experiments_only'] as const) {
      for (const targetingKey of ['first', 'second']) {
        const result = evaluateRulesBasedConfiguration(
          configuration,
          'boolean',
          'flag',
          false,
          { ...context, targetingKey },
          logger,
          optOutMode
        )
        expect(result.errorCode).toBeUndefined()
        expect(result.value).toBe(optOutMode !== 'immediate')
      }
    }
    expect(read).toHaveBeenCalledTimes(1)
  })
})

it('validates activation even without a subject opt-out attribute', () => {
  const configuration = prepareUniversalFlagConfiguration(jsonRules('garbage'))
  expect(evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', true, {}, logger, mode)).toMatchObject({
    value: true,
    errorCode: 'PARSE_ERROR',
    reason: 'ERROR',
  })
})

it.each(['2026-10-01 12:00:00Z', '2026-10-01T12:00:00.1234567890Z'])(
  'requires the canonical timestamp format for received JSON activation %s',
  (activation) => {
    const configuration = prepareUniversalFlagConfiguration(jsonRules(activation))
    expect(
      evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', true, context, logger, mode)
    ).toMatchObject({
      value: true,
      errorCode: 'PARSE_ERROR',
      reason: 'ERROR',
    })
  }
)

it('preserves the JSON wire representation and prepares replacement flags independently', () => {
  const configuration = jsonRules('2026-10-01T12:00:00.123456788Z')
  const serialized = JSON.stringify(configuration)
  prepareUniversalFlagConfiguration(configuration)
  expect(JSON.stringify(configuration)).toBe(serialized)
  expect(evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', false, context, logger, mode).value).toBe(
    true
  )

  const replacement = JSON.parse(serialized) as UniversalFlagConfigurationV1
  replacement.flags.flag.allocations[0].randomizationActivatedAt = 'garbage'
  prepareUniversalFlagConfiguration(replacement)
  expect(evaluateRulesBasedConfiguration(replacement, 'boolean', 'flag', false, context, logger, mode).errorCode).toBe(
    'PARSE_ERROR'
  )
  expect(evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', false, context, logger, mode).value).toBe(
    true
  )
})

it('prepares valid and invalid protobuf replacements at decode time without changing the wire data', () => {
  const raw = rawProtobufRules('2026-10-01T12:00:00.123456788Z')
  const wire = encodeFlagsConfiguration(raw)
  const initial = decodeFlagsConfiguration(wire)
  expect(encodeFlagsConfiguration(initial)).toEqual(wire)

  const activation = raw.flags.flag.allocations[0].randomizationActivatedAt
  if (!activation) throw new Error('Missing test activation')
  activation.nanos = 1e9
  const replacement = decodeFlagsConfiguration(encodeFlagsConfiguration(raw))
  for (const configuration of [initial, replacement]) {
    Object.defineProperty(configuration.flags.flag.allocations[0], 'randomizationActivatedAt', {
      get() {
        throw new Error('activation must already be prepared by the decoder')
      },
    })
  }
  expect(evaluateRulesBasedConfiguration(initial, 'boolean', 'flag', false, context, logger, mode).value).toBe(true)
  expect(evaluateRulesBasedConfiguration(replacement, 'boolean', 'flag', false, context, logger, mode).errorCode).toBe(
    'PARSE_ERROR'
  )
  expect(evaluateRulesBasedConfiguration(initial, 'boolean', 'flag', false, context, logger, mode).value).toBe(true)
})

it.each([
  ['2026-10-01T08:00:00.123456789-04:00', true],
  ['2026-10-01T12:00:00.1234567890Z', false],
  ['2026-10-01T12:00:00.1234567899Z', false],
  ['2026-10-01T12:00:00.123456788Z', false],
  ['2026-10-01T12:00:00.123456790Z', false],
])('acknowledgement %s matches: %s', (timestamp, expected) => {
  const policy = experimentationOptOutPolicy(context, mode)!
  const configuration = {
    precomputed: {
      response: {
        data: {
          attributes: {
            createdAt: cutoff,
            flags: {},
            evaluation_options: { experimentation_opt_out_mode: mode, dd_experimentation_opt_out_at: timestamp },
          },
        },
      },
    },
  }
  expect(acknowledgesExperimentationOptOut(configuration, policy)).toBe(expected)
  const acknowledged = parseOptOutInstant(timestamp)
  expect(!!acknowledged && compareOptOutInstants(parseOptOutInstant(cutoff)!, acknowledged) === 0).toBe(expected)
})
