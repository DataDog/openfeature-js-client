import type { Channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core'
import type { EvaluationContext, Logger } from '@openfeature/core'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'

const logger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}

const mockExposureChannel = {
  hasSubscribers: true,
  publish: jest.fn(),
} as unknown as jest.Mocked<Channel<ExposureEvent>>

function baseConfiguration(): UniversalFlagConfigurationV1 {
  return {
    createdAt: '2026-10-23T00:00:00.000Z',
    format: 'ufc-v1',
    environment: { name: 'test' },
    flags: {
      'holdout-flag': {
        key: 'holdout-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          control: { key: 'control', value: false },
          treatment: { key: 'treatment', value: true },
        },
        allocations: [
          {
            key: 'holdout-allocation',
            doLog: true,
            splits: [
              {
                variationKey: 'control',
                serialId: 1001,
                shards: [{ salt: 'test-salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
                features: [
                  { key: 'holdout.key', value: '06ad', destinations: ['HOOK'] },
                  { key: 'holdout.assignment_group', value: 'status_quo', destinations: ['HOOK'] },
                  { key: 'holdout.should_include_in_holdout_analysis', value: false, destinations: ['HOOK'] },
                  { key: 'exposure.only', value: 'exposed', destinations: ['EXPOSURE'] },
                  { key: 'evaluation.only', value: 7, destinations: ['EVALUATION'] },
                ],
              },
            ],
          },
        ],
      },
    },
  } as unknown as UniversalFlagConfigurationV1
}

function configurationWithSplit(overrides: (split: Record<string, unknown>) => void): UniversalFlagConfigurationV1 {
  const configuration = baseConfiguration()
  const flag = configuration.flags['holdout-flag'] as unknown as Record<string, unknown>
  const allocations = flag.allocations as Array<Record<string, unknown>>
  const splits = allocations[0].splits as unknown as Array<Record<string, unknown>>
  overrides(splits[0])
  return configuration
}

function publishedEvent(index: number): ExposureEvent {
  return mockExposureChannel.publish.mock.calls[index][0] as ExposureEvent
}

async function evaluateFlag(
  provider: DatadogNodeServerProvider,
  configuration: UniversalFlagConfigurationV1,
  targetingKey: string
) {
  provider.setConfiguration(configuration)
  const context: EvaluationContext = { targetingKey }
  return provider.resolveBooleanEvaluation('holdout-flag', true, context, logger)
}

describe('exposure cache verdict', () => {
  beforeEach(() => {
    mockExposureChannel.publish.mockClear()
  })

  it('marks the first evaluation as a new exposure and the repeat as a cache hit', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })
    const configuration = baseConfiguration()

    const first = await evaluateFlag(provider, configuration, 'subject-1')
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

    const repeat = await evaluateFlag(provider, configuration, 'subject-1')
    expect(repeat.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
  })

  it('treats a serial id change as a new exposure', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })

    await evaluateFlag(provider, baseConfiguration(), 'subject-1')
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

    const changed = configurationWithSplit((split) => {
      split.serialId = 1002
    })
    const second = await evaluateFlag(provider, changed, 'subject-1')
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(2)
  })

  it('treats a variant change as a new exposure', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })

    await evaluateFlag(provider, baseConfiguration(), 'subject-1')
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)

    const changed = configurationWithSplit((split) => {
      split.variationKey = 'treatment'
    })
    const second = await evaluateFlag(provider, changed, 'subject-1')
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(2)
    expect(publishedEvent(1).variant.key).toBe('treatment')
  })

  it('records nothing and sends nothing for a failed evaluation', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })
    provider.setConfiguration(baseConfiguration())

    const notFound = await provider.resolveBooleanEvaluation(
      'missing-flag',
      true,
      { targetingKey: 'subject-1' },
      logger
    )
    expect(notFound.errorCode).toBe('FLAG_NOT_FOUND')
    expect(notFound.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(mockExposureChannel.publish).not.toHaveBeenCalled()

    const wrongType = await provider.resolveStringEvaluation(
      'holdout-flag',
      'default',
      { targetingKey: 'subject-1' },
      logger
    )
    expect(wrongType.errorCode).toBe('TYPE_MISMATCH')
    expect(wrongType.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(mockExposureChannel.publish).not.toHaveBeenCalled()

    const success = await provider.resolveBooleanEvaluation('holdout-flag', true, { targetingKey: 'subject-1' }, logger)
    expect(success.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
  })

  it('stamps no verdict when the allocation does not log exposures', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })
    const configuration = baseConfiguration()
    const flag = configuration.flags['holdout-flag'] as unknown as Record<string, unknown>
    const allocation = (flag.allocations as Array<Record<string, unknown>>)[0]
    allocation.doLog = false

    const result = await evaluateFlag(provider, configuration, 'subject-1')
    expect(result.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(mockExposureChannel.publish).not.toHaveBeenCalled()
  })

  it('carries EXPOSURE features on the exposure event without affecting the verdict', async () => {
    const provider = new DatadogNodeServerProvider({ exposureChannel: mockExposureChannel })

    await evaluateFlag(provider, baseConfiguration(), 'subject-1')
    const event = publishedEvent(0)
    expect(event.features).toEqual({ 'exposure.only': 'exposed' })
    expect(event.features?.['holdout.key']).toBeUndefined()

    const changedFeatures = configurationWithSplit((split) => {
      split.features = [{ key: 'exposure.only', value: 'changed', destinations: ['EXPOSURE'] }]
    })
    const repeat = await evaluateFlag(provider, changedFeatures, 'subject-1')
    expect(repeat.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(mockExposureChannel.publish).toHaveBeenCalledTimes(1)
  })
})
