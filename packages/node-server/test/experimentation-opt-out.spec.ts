import { type Channel, channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core'
import type { EvaluationContext, Logger } from '@openfeature/server-sdk'
import { DatadogNodeServerProvider, ExperimentationOptOutMode } from '../src'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'

const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const configuration = {
  createdAt: '2026-01-01T00:00:00Z',
  flags: {
    feature: {
      key: 'feature',
      enabled: true,
      variationType: 'BOOLEAN',
      variations: { treatment: { key: 'treatment', value: true }, ordinary: { key: 'ordinary', value: false } },
      allocations: [
        { key: 'experiment', doLog: true, splits: [{ variationKey: 'treatment', shards: [] }] },
        { key: 'ordinary', doLog: false, splits: [{ variationKey: 'ordinary', shards: [] }] },
      ],
    },
  },
} as unknown as UniversalFlagConfigurationV1

describe('immediate experimentation opt-out', () => {
  const original = process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE
  afterEach(() => {
    if (original === undefined) delete process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE
    else process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = original
  })

  it.each([
    ['immediate', undefined, true],
    ['invalid', undefined, true],
    ['immediate', ExperimentationOptOutMode.Disabled, true],
    ['disabled', ExperimentationOptOutMode.Immediate, false],
    ['invalid', ExperimentationOptOutMode.Disabled, true],
    ['invalid', ExperimentationOptOutMode.Immediate, false],
  ])('ignores environment %s and uses provider option %s', async (environment, mode, expected) => {
    process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = environment
    const provider = new DatadogNodeServerProvider({
      exposureChannel: channel('opt-out-precedence') as Channel<ExposureEvent>,
      experimentationOptOutMode: mode as ExperimentationOptOutMode | undefined,
    })
    provider.setConfiguration(configuration)
    process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = 'invalid-after-construction'
    const result = await provider.resolveBooleanEvaluation(
      'feature',
      true,
      {
        targetingKey: 'athlete',
        dd_experimentation_opt_out_at: '2099-01-01T00:00:00Z',
      },
      logger
    )
    expect(result.value).toBe(expected)
  })

  it.each(['secret-value', 'default', 'future_experiments_only', null])(
    'rejects unsupported provider option %j',
    (mode) => {
      expect(
        () =>
          new DatadogNodeServerProvider({
            exposureChannel: channel('opt-out-invalid') as Channel<ExposureEvent>,
            experimentationOptOutMode: mode as ExperimentationOptOutMode,
          })
      ).toThrow('experimentationOptOutMode must be disabled or immediate')
    }
  )

  it('applies immediate exclusion to every value type', async () => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: channel('opt-out-value-types') as Channel<ExposureEvent>,
      experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
    })
    const flags = Object.fromEntries(
      [
        ['boolean', 'BOOLEAN', true, false],
        ['string', 'STRING', 'experiment', 'ordinary'],
        ['number', 'NUMERIC', 1, 0],
        ['object', 'JSON', { experiment: true }, { ordinary: true }],
      ].map(([key, variationType, treatment, ordinary]) => [
        key,
        {
          ...configuration.flags.feature,
          key,
          variationType,
          variations: {
            treatment: { key: 'treatment', value: treatment },
            ordinary: { key: 'ordinary', value: ordinary },
          },
        },
      ])
    )
    provider.setConfiguration({ ...configuration, flags } as UniversalFlagConfigurationV1)
    const context = { targetingKey: 'athlete', dd_experimentation_opt_out_at: '2099-01-01t00:00:00.123456789z' }
    const results = await Promise.all([
      provider.resolveBooleanEvaluation('boolean', true, context, logger),
      provider.resolveStringEvaluation('string', 'default', context, logger),
      provider.resolveNumberEvaluation('number', -1, context, logger),
      provider.resolveObjectEvaluation('object', { default: true }, context, logger),
    ])
    expect(results.map((result) => result.value)).toEqual([false, 'ordinary', 0, { ordinary: true }])
    for (const result of results) {
      expect(result.errorCode).toBeUndefined()
      expect(result.flagMetadata).toMatchObject({ allocationKey: 'ordinary', doLog: false })
    }
  })

  it.each([
    '2026-02-29T00:00:00Z',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:60Z',
    '2026-01-01 00:00:00Z',
    '0000-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-01:00',
  ])('uses shared timestamp validation for %s', async (timestamp) => {
    const provider = new DatadogNodeServerProvider({
      exposureChannel: channel('opt-out-invalid-timestamp') as Channel<ExposureEvent>,
      experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
    })
    provider.setConfiguration(configuration)
    const result = await provider.resolveBooleanEvaluation(
      'feature',
      false,
      { targetingKey: 'athlete', dd_experimentation_opt_out_at: timestamp },
      logger
    )
    expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'INVALID_CONTEXT' })
  })

  it.each(['2026-01-01t00:00:00z', '2026-01-01T00:00:00.123456789999+01:00'])(
    'accepts the shared timestamp subset %s',
    async (timestamp) => {
      const provider = new DatadogNodeServerProvider({
        exposureChannel: channel('opt-out-valid-timestamp') as Channel<ExposureEvent>,
        experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
      })
      provider.setConfiguration(configuration)
      const result = await provider.resolveBooleanEvaluation(
        'feature',
        true,
        { targetingKey: 'athlete', dd_experimentation_opt_out_at: timestamp },
        logger
      )
      expect(result).toMatchObject({ value: false, reason: 'STATIC' })
      expect(result.errorCode).toBeUndefined()
    }
  )

  it('preserves exposure deduplication across opt-out and resumption', async () => {
    const exposures: ExposureEvent[] = []
    const exposureChannel = channel('opt-out-transitions') as Channel<ExposureEvent>
    const subscriber = (event: unknown) => exposures.push(event as ExposureEvent)
    exposureChannel.subscribe(subscriber)
    try {
      const provider = new DatadogNodeServerProvider({
        exposureChannel,
        experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
      })
      provider.setConfiguration(configuration)
      const eligible = { targetingKey: 'athlete' }
      const optedOut = { ...eligible, dd_experimentation_opt_out_at: '2026-01-01T00:00:00Z' }
      for (const context of [eligible, eligible, optedOut, optedOut, eligible]) {
        const result = await provider.resolveBooleanEvaluation('feature', true, context, logger)
        expect(result.value).toBe(!('dd_experimentation_opt_out_at' in context))
      }
      expect(exposures).toHaveLength(1)
      const invalid = await provider.resolveBooleanEvaluation(
        'feature',
        false,
        {
          targetingKey: 'athlete',
          dd_experimentation_opt_out_at: null,
        } as unknown as EvaluationContext,
        logger
      )
      expect(invalid).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'INVALID_CONTEXT' })
      expect(exposures).toHaveLength(1)
    } finally {
      exposureChannel.unsubscribe(subscriber)
    }
  })
})
