import type { Channel } from 'node:diagnostics_channel'
import { type ExposureEvent, type Flag, OperatorType, type UniversalFlagConfigurationV1 } from '@datadog/flagging-core'
import type { JsonValue, Logger } from '@openfeature/server-sdk'
import { DatadogNodeServerProvider, type DependencyEvaluationEvent } from '../src/provider'

const logger: Logger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}

describe('dependent flag exposures', () => {
  it('publishes successful dependency exposures depth-first before the root', async () => {
    const exposureChannel = channel<ExposureEvent>()
    const dependencyEvaluationChannel = channel<DependencyEvaluationEvent>()
    const provider = new DatadogNodeServerProvider({ exposureChannel, dependencyEvaluationChannel })
    provider.setConfiguration(
      configuration({
        root: dependentFlag('root', ['middle']),
        middle: dependentFlag('middle', ['leaf']),
        leaf: booleanFlag('leaf'),
      })
    )

    await expect(
      provider.resolveBooleanEvaluation('root', false, { targetingKey: 'subject' }, logger)
    ).resolves.toMatchObject({ value: true, variant: 'on' })
    expect(exposureChannel.publish.mock.calls.map(([event]) => (event as ExposureEvent).flag.key)).toEqual([
      'leaf',
      'middle',
      'root',
    ])
    expect(
      dependencyEvaluationChannel.publish.mock.calls.map(
        ([event]) => (event as DependencyEvaluationEvent).details.flagKey
      )
    ).toEqual(['leaf', 'middle'])

    await provider.resolveBooleanEvaluation('root', false, { targetingKey: 'subject' }, logger)
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

    let nestedEvaluation: Promise<unknown> | undefined
    dependencyEvaluationChannel.publish.mockImplementation((published) => {
      const event = published as DependencyEvaluationEvent
      if (event.details.flagKey === 'leaf-a' && nestedEvaluation === undefined) {
        nestedEvaluation = provider.resolveBooleanEvaluation('root-b', false, { targetingKey: 'subject-b' }, logger)
      }
    })

    await expect(
      provider.resolveBooleanEvaluation('root-a', false, { targetingKey: 'subject-a' }, logger)
    ).resolves.toMatchObject({ value: true, variant: 'on' })
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
      ['subject-b', 'leaf-b'],
      ['subject-b', 'root-b'],
      ['subject-a', 'leaf-a'],
      ['subject-a', 'root-a'],
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

    await expect(
      provider.resolveBooleanEvaluation('root', false, { targetingKey: 'subject' }, logger)
    ).resolves.toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' })
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
    await expect(
      provider.resolveBooleanEvaluation('root', false, { targetingKey: 'subject' }, logger)
    ).resolves.toMatchObject({ value: true, variant: 'on' })
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

    await expect(
      provider.resolveBooleanEvaluation('root', false, { targetingKey: 'subject' }, logger)
    ).resolves.toMatchObject({ value: true, variant: 'on' })
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

    await expect(provider.resolveBooleanEvaluation('root', false, context, logger)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    await expect(provider.resolveBooleanEvaluation('root', false, context, logger)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })

    expect(context).toEqual({ targetingKey: 'subject', traits: { tier: 'original' } })
    expect(seenSubjects).toEqual([
      { id: 'subject', tier: 'original' },
      { id: 'subject', tier: 'original' },
    ])
  })
})

function channel<T>(): jest.Mocked<Channel<T, T>> {
  return {
    hasSubscribers: true,
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
