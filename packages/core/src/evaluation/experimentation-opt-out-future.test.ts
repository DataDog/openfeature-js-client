import { fromJson } from '@bufbuild/protobuf'
import { FlagsConfigurationSchema } from '../configuration/generated/ufc_pb'
import * as preparedActivation from '../configuration/prepared-activation'
import { prepareJsonFlagActivations, prepareUniversalFlagConfiguration } from '../configuration/prepared-activation'
import { prepareRulesResponse } from '../configuration/prepared-rules-response'
import { decodeFlagsConfiguration, encodeFlagsConfiguration } from '../configuration/ufc-protobuf'
import { evaluateRulesBasedConfiguration } from './evaluation'
import * as optOut from './experimentation-opt-out'
import {
  acknowledgesExperimentationOptOut,
  compareOptOutInstants,
  excludesExperimentAt,
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

describe.each(['disabled', 'immediate', 'future_experiments_only'] as const)(
  'invalid activation in %s mode',
  (optOutMode) => {
    it.each([false, true])('isolates the affected flag only when activation is needed (opted out: %s)', (optedOut) => {
      const subject = optedOut ? context : { targetingKey: 'subject' }
      const expected = optOutMode === 'future_experiments_only' && optedOut ? 'PARSE_ERROR' : undefined
      const json = jsonRules('garbage')
      json.flags.flag.allocations.reverse()
      json.flags.neighbor = { ...json.flags.flag, key: 'neighbor', allocations: [json.flags.flag.allocations[0]] }
      prepareUniversalFlagConfiguration(json)
      const proto = rawProtobufRules(cutoff)
      proto.flags.flag.allocations[0].randomizationActivatedAt!.nanos = 1e9
      proto.flags.neighbor = { ...proto.flags.flag, allocations: [proto.flags.flag.allocations[1]] }
      proto.flags.flag.allocations.reverse()
      prepareRulesResponse(proto)
      for (const configuration of [json, proto]) {
        const result = evaluateRulesBasedConfiguration(
          configuration,
          'boolean',
          'flag',
          true,
          subject,
          logger,
          optOutMode
        )
        expect(result.errorCode).toBe(expected)
        expect(result.value).toBe(expected !== undefined)
        const neighbor = evaluateRulesBasedConfiguration(
          configuration,
          'boolean',
          'neighbor',
          true,
          subject,
          logger,
          optOutMode
        )
        expect(neighbor).toMatchObject({ value: false, reason: 'STATIC' })
        expect(neighbor.errorCode).toBeUndefined()
      }
    })
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

it('retains invalid activation separately from missing metadata for future consumers', () => {
  const configuration = prepareUniversalFlagConfiguration(jsonRules('garbage'))
  const prepared = prepareJsonFlagActivations(configuration.flags.flag)
  expect(prepared.valid).toBe(false)
  expect(prepared.allocations.map(({ activation }) => activation.kind)).toEqual(['invalid', 'missing'])
  const policy = experimentationOptOutPolicy(context, mode)!
  expect(() => excludesExperimentAt(policy, true, prepared.allocations[0].activation)).toThrow(
    'Invalid randomization activation timestamp'
  )
})

it('allows an unreadable activation on the selected allocation when it is not needed', () => {
  const json = prepareUniversalFlagConfiguration(jsonRules('garbage'))
  const proto = rawProtobufRules(cutoff)
  proto.flags.flag.allocations[0].randomizationActivatedAt!.nanos = 1e9
  prepareRulesResponse(proto)
  for (const configuration of [json, proto]) {
    for (const optOutMode of ['disabled', 'immediate', 'future_experiments_only'] as const) {
      const result = evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', false, {}, logger, optOutMode)
      expect(result).toMatchObject({ value: true, reason: 'STATIC' })
      expect(result.errorCode).toBeUndefined()
    }
  }
})

it.each(['2026-10-01 12:00:00Z', '2026-10-01T12:00:00 UTC'])(
  'requires the supported timestamp format for received JSON activation %s',
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

it.each([
  ['2026-10-01t08:00:00.123456788999-04:00', true],
  ['2026-10-01t12:00:00.123456789999z', false],
])('normalizes JSON activation %s and the subject cutoff to nanoseconds', (activation, expected) => {
  const configuration = prepareUniversalFlagConfiguration(jsonRules(activation))
  const subject = { ...context, dd_experimentation_opt_out_at: '2026-10-01t12:00:00.123456789001z' }
  const result = evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', !expected, subject, logger, mode)
  expect(result.value).toBe(expected)
  expect(result.errorCode).toBeUndefined()
})

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
  ['2026-10-01t12:00:00.123456789z', true],
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
  const acknowledged = parseOptOutInstant(timestamp)
  expect(!!acknowledged && compareOptOutInstants(parseOptOutInstant(cutoff)!, acknowledged) === 0).toBe(expected)
})

describe.each([false, true])('JSON inactive opt-out (prepared: %s)', (prepared) => {
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [undefined, context],
    [false, context],
    ['disabled', { targetingKey: 'subject', dd_experimentation_opt_out_at: 'invalid' }],
    ['immediate', { targetingKey: 'subject' }],
    ['future_experiments_only', { targetingKey: 'subject' }],
  ] as const)('skips activation preparation and exclusion checks for %s', (optOutMode, subject) => {
    const configuration = jsonRules('invalid')
    if (prepared) prepareUniversalFlagConfiguration(configuration)
    const preparation = jest.spyOn(preparedActivation, 'prepareJsonFlagActivations')
    const exclusion = jest.spyOn(optOut, 'excludesExperimentAt')
    for (let index = 0; index < 2; index++) {
      const result = evaluateRulesBasedConfiguration(
        configuration,
        'boolean',
        'flag',
        false,
        subject,
        logger,
        optOutMode
      )
      expect(result).toMatchObject({
        value: true,
        reason: 'STATIC',
        flagMetadata: { allocationKey: 'experiment', doLog: true },
      })
      expect(result.errorCode).toBeUndefined()
    }
    expect(preparation).not.toHaveBeenCalled()
    expect(exclusion).not.toHaveBeenCalled()
  })

  it('still calls the exclusion boundary for an active policy', () => {
    const configuration = jsonRules()
    if (prepared) prepareUniversalFlagConfiguration(configuration)
    const exclusion = jest.spyOn(optOut, 'excludesExperimentAt')
    const result = evaluateRulesBasedConfiguration(configuration, 'boolean', 'flag', true, context, logger, 'immediate')
    expect(result).toMatchObject({ value: false, reason: 'STATIC' })
    expect(exclusion).toHaveBeenCalledTimes(2)
  })
})
