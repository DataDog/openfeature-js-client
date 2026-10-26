import type { Channel } from 'node:diagnostics_channel'
import type { ExposureEvent } from '@datadog/flagging-core'
import { type EvaluationContext, type Logger, OpenFeature } from '@openfeature/server-sdk'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider } from '../src/provider'

const logger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}

function exposureChannel(hasSubscribers: boolean): jest.Mocked<Channel<ExposureEvent>> {
  return {
    hasSubscribers,
    publish: jest.fn(),
  } as unknown as jest.Mocked<Channel<ExposureEvent>>
}

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

function publishedEvent(channel: jest.Mocked<Channel<ExposureEvent>>, index: number): ExposureEvent {
  return channel.publish.mock.calls[index][0] as ExposureEvent
}

describe('exposure cache verdict', () => {
  let providerName: string

  beforeEach(() => {
    providerName = `exposure-verdict-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
  })

  async function evaluate(
    provider: DatadogNodeServerProvider,
    configuration: UniversalFlagConfigurationV1,
    targetingKey: string,
    clientName?: string
  ) {
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait(providerName, provider)
    const client = OpenFeature.getClient(clientName ?? providerName)
    const context: EvaluationContext = { targetingKey }
    return client.getBooleanDetails('holdout-flag', true, context)
  }

  it('marks the first evaluation as a new exposure and the repeat as a cache hit', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })
    const configuration = baseConfiguration()

    const first = await evaluate(provider, configuration, 'subject-1')
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).toHaveBeenCalledTimes(1)

    const repeat = await evaluate(provider, configuration, 'subject-1')
    expect(repeat.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(channel.publish).toHaveBeenCalledTimes(1)
  })

  it('treats a serial id change as a new exposure', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })

    await evaluate(provider, baseConfiguration(), 'subject-1')
    expect(channel.publish).toHaveBeenCalledTimes(1)

    const changed = configurationWithSplit((split) => {
      split.serialId = 1002
    })
    const second = await evaluate(provider, changed, 'subject-1')
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).toHaveBeenCalledTimes(2)
  })

  it('treats a variant change as a new exposure', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })

    await evaluate(provider, baseConfiguration(), 'subject-1')
    expect(channel.publish).toHaveBeenCalledTimes(1)

    const changed = configurationWithSplit((split) => {
      split.variationKey = 'treatment'
    })
    const second = await evaluate(provider, changed, 'subject-1')
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).toHaveBeenCalledTimes(2)
    expect(publishedEvent(channel, 1).variant.key).toBe('treatment')
  })

  it('records nothing and sends nothing for a failed evaluation', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })
    provider.setConfiguration(baseConfiguration())
    await OpenFeature.setProviderAndWait(providerName, provider)
    const client = OpenFeature.getClient(providerName)

    const notFound = await client.getBooleanDetails('missing-flag', true, { targetingKey: 'subject-1' })
    expect(notFound.errorCode).toBe('FLAG_NOT_FOUND')
    expect(notFound.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(channel.publish).not.toHaveBeenCalled()

    const wrongType = await client.getStringDetails('holdout-flag', 'default', { targetingKey: 'subject-1' })
    expect(wrongType.errorCode).toBe('TYPE_MISMATCH')
    expect(wrongType.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(channel.publish).not.toHaveBeenCalled()

    const success = await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    expect(success.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).toHaveBeenCalledTimes(1)
  })

  it('publishes and records nothing when a later application hook fails the evaluation', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })
    provider.setConfiguration(baseConfiguration())
    await OpenFeature.setProviderAndWait(providerName, provider)

    const failingClient = OpenFeature.getClient(providerName)

    const failed = await failingClient.getBooleanDetails(
      'holdout-flag',
      true,
      { targetingKey: 'subject-1' },
      {
        hooks: [
          {
            after: () => {
              throw new Error('application hook failed')
            },
          },
        ],
      }
    )
    expect(failed.errorCode).toBe('GENERAL')
    expect(failed.value).toBe(true)
    expect(channel.publish).not.toHaveBeenCalled()

    const client = OpenFeature.getClient(providerName)
    const retried = await client.getBooleanDetails('holdout-flag', true, { targetingKey: 'subject-1' })
    expect(retried.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).toHaveBeenCalledTimes(1)
  })

  it('stamps no verdict when the allocation does not log exposures', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })
    const configuration = baseConfiguration()
    const flag = configuration.flags['holdout-flag'] as unknown as Record<string, unknown>
    const allocation = (flag.allocations as Array<Record<string, unknown>>)[0]
    allocation.doLog = false

    const result = await evaluate(provider, configuration, 'subject-1')
    expect(result.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    expect(channel.publish).not.toHaveBeenCalled()
  })

  it('carries EXPOSURE features on the exposure event without affecting the verdict', async () => {
    const channel = exposureChannel(true)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })

    await evaluate(provider, baseConfiguration(), 'subject-1')
    const event = publishedEvent(channel, 0)
    expect(event.features).toEqual({ 'exposure.only': 'exposed' })
    expect(event.features?.['holdout.key']).toBeUndefined()

    const changedFeatures = configurationWithSplit((split) => {
      split.features = [{ key: 'exposure.only', value: 'changed', destinations: ['EXPOSURE'] }]
    })
    const repeat = await evaluate(provider, changedFeatures, 'subject-1')
    expect(repeat.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(channel.publish).toHaveBeenCalledTimes(1)
  })

  it('records the cache verdict even when nothing subscribes to the exposure channel', async () => {
    const channel = exposureChannel(false)
    const provider = new DatadogNodeServerProvider({ exposureChannel: channel })

    const first = await evaluate(provider, baseConfiguration(), 'subject-1')
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(channel.publish).not.toHaveBeenCalled()

    const repeat = await evaluate(provider, baseConfiguration(), 'subject-1')
    expect(repeat.flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    expect(channel.publish).not.toHaveBeenCalled()
  })
})
