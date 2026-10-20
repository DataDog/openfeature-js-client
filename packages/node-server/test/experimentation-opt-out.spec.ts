import { type Channel, channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core'
import type { EvaluationContext, Logger } from '@openfeature/server-sdk'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'
import { ExperimentationOptOutMode } from '../src/experimentation-opt-out'
import { DatadogNodeServerProvider } from '../src/provider'

const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const configuration = {
  createdAt: '2026-01-01T00:00:00Z',
  flags: {
    feature: {
      key: 'feature', enabled: true, variationType: 'BOOLEAN',
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
    ['', undefined, true], ['disabled', undefined, true], ['immediate', undefined, false],
    [' Immediate ', undefined, false], ['immediate', ExperimentationOptOutMode.Disabled, true],
    ['disabled', ExperimentationOptOutMode.Immediate, false],
    ['invalid', ExperimentationOptOutMode.Disabled, true],
    ['invalid', ExperimentationOptOutMode.Immediate, false],
  ])('resolves %s with override %s', async (environment, mode, expected) => {
    process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = environment
    const provider = new DatadogNodeServerProvider({
      exposureChannel: channel('opt-out-precedence') as Channel<ExposureEvent>,
      experimentationOptOutMode: mode as ExperimentationOptOutMode | undefined,
    })
    provider.setConfiguration(configuration)
    process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = 'invalid-after-construction'
    const result = await provider.resolveBooleanEvaluation('feature', true, {
      targetingKey: 'athlete', dd_experimentation_opt_out_at: '2099-01-01T00:00:00Z',
    }, logger)
    expect(result.value).toBe(expected)
  })

  it('rejects unsupported configuration without including its value', () => {
    process.env.DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE = 'secret-value'
    expect(() => new DatadogNodeServerProvider({
      exposureChannel: channel('opt-out-invalid') as Channel<ExposureEvent>,
    })).toThrow('DD_FEATURE_FLAGS_EXPERIMENTATION_OPT_OUT_MODE must be disabled or immediate')
  })

  it('preserves exposure deduplication across opt-out and resumption', async () => {
    const exposures: ExposureEvent[] = []
    const exposureChannel = channel('opt-out-transitions') as Channel<ExposureEvent>
    const subscriber = (event: unknown) => exposures.push(event as ExposureEvent)
    exposureChannel.subscribe(subscriber)
    try {
      const provider = new DatadogNodeServerProvider({
        exposureChannel, experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
      })
      provider.setConfiguration(configuration)
      const eligible = { targetingKey: 'athlete' }
      const optedOut = { ...eligible, dd_experimentation_opt_out_at: '2026-01-01T00:00:00Z' }
      for (const context of [eligible, eligible, optedOut, optedOut, eligible]) {
        const result = await provider.resolveBooleanEvaluation('feature', true, context, logger)
        expect(result.value).toBe(!('dd_experimentation_opt_out_at' in context))
      }
      expect(exposures).toHaveLength(1)
      const invalid = await provider.resolveBooleanEvaluation('feature', false, {
        targetingKey: 'athlete', dd_experimentation_opt_out_at: null,
      } as unknown as EvaluationContext, logger)
      expect(invalid).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'INVALID_CONTEXT' })
      expect(exposures).toHaveLength(1)
    } finally {
      exposureChannel.unsubscribe(subscriber)
    }
  })
})
