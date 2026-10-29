import type { Channel } from 'node:diagnostics_channel'
import { type ExposureEvent, type Flag, OperatorType, type UniversalFlagConfigurationV1 } from '@datadog/flagging-core'
import { type JsonValue, OpenFeature } from '@openfeature/server-sdk'
import { DatadogNodeServerProvider, type DependencyEvaluationEvent } from '../src/provider'

describe('dependent flag exposures', () => {
  let providerName: string

  beforeEach(() => {
    providerName = `dependent-exposures-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
  })

  async function clientFor(provider: DatadogNodeServerProvider) {
    await OpenFeature.setProviderAndWait(providerName, provider)
    return OpenFeature.getClient(providerName)
  }

  it('publishes successful dependency exposures depth-first before the root', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    const leaf = booleanFlag('leaf')
    leaf.allocations[0].splits[0].features = [
      { key: 'dependency.feature', value: 'enabled', destinations: ['EXPOSURE'] },
    ]
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['middle']),
        middle: dependentFlag('middle', ['leaf']),
        leaf,
      })
    )
    const client = await clientFor(provider)

    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(exposureChannel.publish.mock.calls.map(([event]) => (event as ExposureEvent).flag.key)).toEqual([
      'leaf',
      'middle',
      'root',
    ])
    expect((exposureChannel.publish.mock.calls[0][0] as ExposureEvent).features).toEqual({
      'dependency.feature': 'enabled',
    })
    expect(
      dependencyEvaluationChannel.publish.mock.calls.map(
        ([event]) => (event as DependencyEvaluationEvent).details.flagKey
      )
    ).toEqual(['leaf', 'middle'])

    await client.getBooleanDetails('root', false, { targetingKey: 'subject' })
    expect(exposureChannel.publish).toHaveBeenCalledTimes(3)
    expect(dependencyEvaluationChannel.publish).toHaveBeenCalledTimes(4)
  })

  it('keeps re-entrant root evaluation sessions isolated', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    provider.setConfiguration(
      configuration({
        'root-a': dependentFlag('root-a', ['leaf-a']),
        'leaf-a': booleanFlag('leaf-a'),
        'root-b': dependentFlag('root-b', ['leaf-b']),
        'leaf-b': booleanFlag('leaf-b'),
      })
    )
    const client = await clientFor(provider)

    let nestedEvaluation: Promise<unknown> | undefined
    dependencyEvaluationChannel.publish.mockImplementation((published) => {
      const event = published as DependencyEvaluationEvent
      if (event.details.flagKey === 'leaf-a' && nestedEvaluation === undefined) {
        nestedEvaluation = client.getBooleanDetails('root-b', false, { targetingKey: 'subject-b' })
      }
    })

    await expect(client.getBooleanDetails('root-a', false, { targetingKey: 'subject-a' })).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    await expect(nestedEvaluation).resolves.toMatchObject({ value: true, variant: 'on' })

    expect(
      dependencyEvaluationChannel.publish.mock.calls.map(([published]) => {
        const event = published as DependencyEvaluationEvent
        return [event.context.targetingKey, event.details.flagKey]
      })
    ).toEqual([
      ['subject-a', 'leaf-a'],
      ['subject-b', 'leaf-b'],
    ])
    expect(
      exposureChannel.publish.mock.calls.map(([published]) => {
        const event = published as ExposureEvent
        return [event.subject.id, event.flag.key]
      })
    ).toEqual([
      ['subject-a', 'leaf-a'],
      ['subject-a', 'root-a'],
      ['subject-b', 'leaf-b'],
      ['subject-b', 'root-b'],
    ])
  })

  it('rolls back provider exposures and deduplication when a nested dependency fails', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['successful', 'parent']),
        successful: booleanFlag('successful'),
        parent: dependentFlag('parent', ['missing']),
      })
    )
    const client = await clientFor(provider)

    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    })
    expect(
      dependencyEvaluationChannel.publish.mock.calls.map(([published]) => {
        const event = published as DependencyEvaluationEvent
        return [event.details.flagKey, event.details.reason, event.details.errorCode]
      })
    ).toEqual([
      ['successful', 'STATIC', undefined],
      ['missing', 'ERROR', 'FLAG_NOT_FOUND'],
      ['parent', 'ERROR', 'FLAG_NOT_FOUND'],
    ])
    expect(exposureChannel.publish).not.toHaveBeenCalled()

    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['successful', 'parent']),
        successful: booleanFlag('successful'),
        parent: dependentFlag('parent', ['missing']),
        missing: booleanFlag('missing'),
      })
    )
    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(exposureChannel.publish.mock.calls.map(([event]) => (event as ExposureEvent).flag.key)).toEqual([
      'successful',
      'missing',
      'parent',
      'root',
    ])
  })

  it('does not snapshot dependency values without evaluation subscribers', async () => {
    let valueReads = 0
    const value: Record<string, JsonValue> = {}
    Object.defineProperty(value, 'nested', {
      enumerable: true,
      get: () => {
        valueReads += 1
        return true
      },
    })
    const exposureChannel = channel<ExposureEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['json-prerequisite']),
        'json-prerequisite': jsonFlag('json-prerequisite', value),
      })
    )
    const client = await clientFor(provider)

    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(valueReads).toBe(0)
  })

  it('isolates caller and later exposure contexts from telemetry subscriber mutation', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['leaf']),
        leaf: booleanFlag('leaf'),
      })
    )
    const client = await clientFor(provider)
    const context = { targetingKey: 'subject', traits: { tier: 'original' } }
    dependencyEvaluationChannel.publish.mockImplementation((published) => {
      const event = published as DependencyEvaluationEvent
      event.context.targetingKey = 'mutated-by-evaluation-subscriber'
      ;(event.context.traits as Record<string, unknown>).tier = 'mutated-by-evaluation-subscriber'
    })
    const seenSubjects: Array<{ id: string; tier: unknown }> = []
    exposureChannel.publish.mockImplementation((published) => {
      const event = published as ExposureEvent
      const traits = event.subject.attributes.traits as Record<string, unknown>
      seenSubjects.push({ id: event.subject.id, tier: traits.tier })
      traits.tier = 'mutated-by-exposure-subscriber'
    })

    await expect(client.getBooleanDetails('root', false, context)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    await expect(client.getBooleanDetails('root', false, context)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })

    expect(context).toEqual({ targetingKey: 'subject', traits: { tier: 'original' } })
    expect(seenSubjects).toEqual([
      { id: 'subject', tier: 'original' },
      { id: 'subject', tier: 'original' },
    ])
  })

  it('publishes and records no graph exposures when a later application hook fails', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['leaf']),
        leaf: booleanFlag('leaf'),
      })
    )
    const client = await clientFor(provider)

    const failed = await client.getBooleanDetails(
      'root',
      false,
      { targetingKey: 'subject' },
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
    expect(failed).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'GENERAL' })
    expect(exposureChannel.publish).not.toHaveBeenCalled()
    expect(dependencyEvaluationChannel.publish).toHaveBeenCalledTimes(1)

    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      variant: 'on',
      flagMetadata: { __dd_exposure_cache_hit: false },
    })
    expect(exposureChannel.publish.mock.calls.map(([event]) => (event as ExposureEvent).flag.key)).toEqual([
      'leaf',
      'root',
    ])
  })

  it('records dependency exposure decisions when the exposure channel has no subscribers', async () => {
    const exposureChannel = channel<ExposureEvent>(false)
    const provider = new DatadogNodeServerProvider({ exposureChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['leaf']),
        leaf: booleanFlag('leaf'),
      })
    )
    const client = await clientFor(provider)

    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      flagMetadata: { __dd_exposure_cache_hit: false },
    })
    expect(exposureChannel.publish).not.toHaveBeenCalled()

    Object.defineProperty(exposureChannel, 'hasSubscribers', { value: true })
    await expect(client.getBooleanDetails('root', false, { targetingKey: 'subject' })).resolves.toMatchObject({
      value: true,
      flagMetadata: { __dd_exposure_cache_hit: true },
    })
    expect(exposureChannel.publish).not.toHaveBeenCalled()
  })
})

function channel<T>(hasSubscribers = true): jest.Mocked<Channel<T, T>> {
  return {
    hasSubscribers,
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    bindStore: jest.fn(),
    unbindStore: jest.fn(),
    runStores: jest.fn(),
    name: 'test-channel',
  } as jest.Mocked<Channel<T, T>>
}

function configuration(flags: Record<string, Flag>): UniversalFlagConfigurationV1 {
  return {
    createdAt: '2026-10-07T12:00:00Z',
    format: 'SERVER',
    environment: { name: 'test' },
    flags,
  }
}

function booleanFlag(key: string): Flag {
  return {
    key,
    enabled: true,
    variationType: 'BOOLEAN',
    variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
    allocations: [{ key: `${key}-allocation`, doLog: true, rules: [], splits: [{ variationKey: 'on', shards: [] }] }],
  }
}

function jsonFlag(key: string, value: Record<string, JsonValue>): Flag {
  return {
    key,
    enabled: true,
    variationType: 'JSON',
    variations: { on: { key: 'on', value } },
    allocations: [{ key: `${key}-allocation`, doLog: true, rules: [], splits: [{ variationKey: 'on', shards: [] }] }],
  }
}

function dependentFlag(key: string, dependencies: string[]): Flag {
  return {
    key,
    enabled: true,
    variationType: 'BOOLEAN',
    variations: { on: { key: 'on', value: true }, off: { key: 'off', value: false } },
    allocations: [
      {
        key: `${key}-targeted`,
        doLog: true,
        rules: [
          {
            conditions: dependencies.map((dependency) => ({
              flagEvaluation: { key: dependency },
              operator: OperatorType.ONE_OF,
              value: ['on'],
            })),
          },
        ],
        splits: [{ variationKey: 'on', shards: [] }],
      },
      { key: `${key}-default`, doLog: true, rules: [], splits: [{ variationKey: 'off', shards: [] }] },
    ],
  }
}
