import type { Channel } from 'node:diagnostics_channel'
import { type ExposureEvent, type Flag, OperatorType, type UniversalFlagConfigurationV1 } from '@datadog/flagging-core'
import type { Logger } from '@openfeature/server-sdk'
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
