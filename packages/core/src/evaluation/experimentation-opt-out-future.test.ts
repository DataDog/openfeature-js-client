import { fromJson } from '@bufbuild/protobuf'
import { FlagsConfigurationSchema } from '../configuration/generated/ufc_pb'
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
  return decodeFlagsConfiguration(
    encodeFlagsConfiguration(
      fromJson(FlagsConfigurationSchema, {
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
    )
  )
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

it('rejects malformed activation on the affected flag, including unreachable allocations', () => {
  const json = jsonRules('garbage')
  json.flags.neighbor = { ...json.flags.flag, key: 'neighbor', allocations: [json.flags.flag.allocations[1]] }
  expect(evaluateRulesBasedConfiguration(json, 'boolean', 'flag', false, context, logger, mode).errorCode).toBe(
    'PARSE_ERROR'
  )
  expect(evaluateRulesBasedConfiguration(json, 'boolean', 'neighbor', true, context, logger, mode)).toMatchObject({
    value: false,
    reason: 'STATIC',
  })
  const proto = protobufRules(cutoff)
  proto.flags.flag.allocations[0].randomizationActivatedAt!.nanos = 1e9
  proto.flags.neighbor = { ...proto.flags.flag, allocations: [proto.flags.flag.allocations[1]] }
  expect(evaluateRulesBasedConfiguration(proto, 'boolean', 'flag', false, context, logger, mode).errorCode).toBe(
    'PARSE_ERROR'
  )
  expect(evaluateRulesBasedConfiguration(proto, 'boolean', 'neighbor', true, context, logger, mode).value).toBe(false)
})

it.each([
  ['2026-10-01T08:00:00.123456789-04:00', true],
  ['2026-10-01T12:00:00.1234567890Z', true],
  ['2026-10-01T12:00:00.1234567899Z', true],
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
  expect(compareOptOutInstants(parseOptOutInstant(cutoff)!, parseOptOutInstant(timestamp)!) === 0).toBe(expected)
})
