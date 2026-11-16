import { type Channel, channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'
import { type ExposureEvent, LRUInMemoryAssignmentCache } from '@datadog/flagging-core'
import { InMemoryProvider, OpenFeature } from '@openfeature/server-sdk'
import type { UniversalFlagConfigurationV1 } from '../src/configuration/ufc-v1'
import { DatadogNodeServerProvider, type DatadogNodeServerProviderOptions } from '../src/provider'
import type { SDKDiagnostic } from '../src/sdk-diagnostics'

jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn() } }))

const NOW = Date.UTC(2026, 10, 5)
const configuration: UniversalFlagConfigurationV1 = {
  createdAt: '2026-11-05T00:00:00Z',
  format: 'SERVER',
  environment: { name: 'test' },
  flags: {},
}

describe('provider SDK diagnostics', () => {
  let provider: DatadogNodeServerProvider
  let observations: SDKDiagnostic[]
  let monotonic: number

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
    monotonic = 0
    jest
      .mocked(performance.now)
      .mockReset()
      .mockImplementation(() => monotonic)
    observations = []
    provider = create()
  })

  afterEach(async () => {
    await provider.onClose()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function create(
    onDiagnostic: DatadogNodeServerProviderOptions['onDiagnostic'] = (event) => {
      observations.push(event)
    }
  ) {
    return new DatadogNodeServerProvider({
      exposureChannel: channel('test:sdk-diagnostics') as Channel<ExposureEvent>,
      onDiagnostic,
    })
  }

  async function advance(ms: number) {
    monotonic += ms
    await jest.advanceTimersByTimeAsync(ms)
  }

  async function ready() {
    provider.setConfiguration(configuration)
    await provider.initialize()
  }

  function failFetch() {
    provider.reportConfigurationFetchStart()
    provider.reportConfigurationFetchResult(false)
  }

  it('measures initialization without any evaluations or transport', async () => {
    const pending = provider.initialize()
    await advance(20)
    provider.setConfiguration(configuration)
    await pending
    expect(observations).toEqual([
      {
        timestamp: NOW + 20,
        event_type: 'sdk_initialization',
        initialization: {
          outcome: 'ready',
          started_at_ms: NOW,
          duration_ms: 20,
          final: true,
          milestones: { configuration_received: { elapsed_ms: 20 }, provider_ready: { elapsed_ms: 20 } },
        },
      },
    ])
  })

  it('keeps the preloaded configuration milestone at zero when readiness takes time', async () => {
    provider.setConfiguration(configuration)
    jest.mocked(performance.now).mockReturnValueOnce(5).mockReturnValueOnce(10)
    await provider.initialize()
    expect(observations).toEqual([
      {
        timestamp: NOW,
        event_type: 'sdk_initialization',
        initialization: {
          outcome: 'ready',
          started_at_ms: NOW,
          duration_ms: 5,
          final: true,
          milestones: { configuration_received: { elapsed_ms: 0 }, provider_ready: { elapsed_ms: 5 } },
        },
      },
    ])
  })

  it('separates configuration receipt from readiness when cache setup is slow', async () => {
    let finishCache!: () => void
    jest.spyOn(LRUInMemoryAssignmentCache.prototype, 'init').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCache = resolve
        })
    )
    const pending = provider.initialize()
    await advance(10)
    provider.setConfiguration(configuration)
    await advance(15)
    finishCache()
    await pending
    expect(observations).toEqual([
      expect.objectContaining({
        timestamp: NOW + 25,
        initialization: expect.objectContaining({
          outcome: 'ready',
          duration_ms: 25,
          milestones: { configuration_received: { elapsed_ms: 10 }, provider_ready: { elapsed_ms: 25 } },
        }),
      }),
    ])
  })

  it('keeps waiting when a null configuration arrives during initialization', async () => {
    const pending = provider.initialize()
    provider.setConfiguration(null)
    await advance(10)
    expect(observations).toEqual([])
    provider.setConfiguration(configuration)
    await pending
    expect(observations[0]).toMatchObject({
      initialization: { outcome: 'ready', milestones: { configuration_received: { elapsed_ms: 10 } } },
    })
  })

  it('suppresses fetch failures before initialization finishes, with or without a start', async () => {
    const pending = provider.initialize()
    provider.reportConfigurationFetchResult(false)
    provider.reportConfigurationFetchStart()
    provider.reportConfigurationFetchResult(false)
    provider.setConfiguration(configuration)
    await pending
    failFetch()
    expect(observations.map((observation) => observation.event_type)).toEqual(['sdk_initialization', 'provider_error'])
  })

  for (const outcome of ['preloaded', 'ready', 'failed', 'rules removed', 'cache failed'] as const) {
    it(`preserves ${outcome} when closed in the same turn`, async () => {
      const error = new Error('initialization failure')
      const failed = outcome === 'failed' || outcome === 'rules removed' || outcome === 'cache failed'
      if (outcome === 'preloaded') provider.setConfiguration(configuration)
      if (outcome === 'cache failed') jest.spyOn(LRUInMemoryAssignmentCache.prototype, 'init').mockRejectedValue(error)
      const pending = provider.initialize()
      const settled = failed ? expect(pending).rejects.toThrow() : pending
      if (outcome === 'failed') provider.setError(error)
      else if (outcome !== 'preloaded') provider.setConfiguration(configuration)
      if (outcome === 'rules removed') provider.setConfiguration(undefined)
      await Promise.all([provider.onClose(), settled])
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({ initialization: { outcome: failed ? 'failed' : 'ready', final: true } })
    })
  }

  for (const action of ['close', 'replace'] as const) {
    it(`reports preloaded rules as ready through OpenFeature ${action}`, async () => {
      provider.setConfiguration(configuration)
      OpenFeature.setProvider(provider)
      if (action === 'close') await OpenFeature.close()
      else {
        await OpenFeature.setProviderAndWait(new InMemoryProvider({}))
        await OpenFeature.close()
      }
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({ initialization: { outcome: 'ready' } })
    })
  }

  it('reports a pending close once and ignores later settlement', async () => {
    const pending = provider.initialize()
    await advance(25)
    await provider.onClose()
    await provider.onClose()
    provider.setConfiguration(configuration)
    await pending
    failFetch()
    expect(observations).toEqual([
      {
        timestamp: NOW + 25,
        event_type: 'sdk_initialization',
        initialization: {
          outcome: 'incomplete',
          reason: 'provider_closed',
          started_at_ms: NOW,
          duration_ms: 25,
          final: false,
          milestones: {},
        },
      },
    ])
  })

  it('does not restart diagnostics when initialized again after close', async () => {
    await ready()
    await provider.onClose()
    await provider.initialize()
    failFetch()
    expect(observations).toHaveLength(1)
  })

  it('does not observe construction or close before initialization', () => {
    provider.onClose()
    expect(observations).toEqual([])
    expect(performance.now).not.toHaveBeenCalled()
  })

  it('preserves the original error without exposing its message', async () => {
    const error = new Error('private credential')
    const rejected = expect(provider.initialize()).rejects.toBe(error)
    provider.setError(error)
    await rejected
    expect(observations).toEqual([
      {
        timestamp: NOW,
        event_type: 'sdk_initialization',
        error_code: 'INIT_FAILED',
        initialization: { outcome: 'failed', started_at_ms: NOW, duration_ms: 0, final: true, milestones: {} },
      },
    ])
  })

  for (const outcome of ['ready', 'timeout'] as const) {
    it(`does not duplicate a startup fetch failure that completes after ${outcome}`, async () => {
      provider.reportConfigurationFetchStart()
      const pending = provider.initialize()
      const settled = outcome === 'timeout' ? expect(pending).rejects.toThrow('Initialization timeout') : pending
      if (outcome === 'timeout') await advance(30_000)
      else provider.setConfiguration(configuration)
      await settled
      provider.reportConfigurationFetchResult(false)
      expect(observations).toHaveLength(1)
      failFetch()
      expect(observations[1]).toMatchObject({ event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED' })
      provider.setConfiguration(configuration)
      provider.reportConfigurationFetchResult(true)
      expect(observations).toHaveLength(2)
    })
  }

  it('suppresses repeated outages until success and reports at most once per minute', async () => {
    await ready()
    failFetch()
    await advance(59_999)
    provider.reportConfigurationFetchResult(true)
    failFetch()
    expect(observations).toHaveLength(2)
    await advance(1)
    failFetch()
    failFetch()
    expect(observations).toHaveLength(3)
    provider.reportConfigurationFetchResult(true)
    failFetch()
    expect(observations).toHaveLength(3)
    await advance(60_000)
    failFetch()
    expect(observations).toHaveLength(4)
    expect(provider.getConfiguration()).toBe(configuration)
  })

  it('reports a sustained outage that begins inside the rate-limit window', async () => {
    await ready()
    failFetch()
    await advance(10_000)
    provider.reportConfigurationFetchResult(true)
    await advance(10_000)
    for (let i = 0; i < 120; i++) {
      failFetch()
      await advance(30_000)
    }
    expect(observations.filter((observation) => observation.event_type === 'provider_error')).toHaveLength(2)
  })

  it('does not classify arbitrary provider errors as fetch errors', async () => {
    await ready()
    provider.setError(new Error('application error'))
    expect(observations).toHaveLength(1)
  })

  it.each(['synchronous', 'asynchronous'])(
    'contains %s callback errors during initialization, polling, and close',
    async (kind) => {
      const onDiagnostic = jest.fn(
        kind === 'synchronous'
          ? () => {
              throw new Error('callback failure')
            }
          : async () => {
              throw new Error('callback failure')
            }
      )
      provider = create(onDiagnostic)
      await ready()
      expect(failFetch).not.toThrow()
      await expect(provider.onClose()).resolves.toBeUndefined()
      provider = create(onDiagnostic)
      const pending = provider.initialize()
      provider.onClose()
      provider.setConfiguration(configuration)
      await pending
      await advance(0)
      expect(onDiagnostic).toHaveBeenCalledTimes(3)
    }
  )

  it('does not wait for diagnostic delivery during initialization or close', async () => {
    let completeDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      completeDelivery = resolve
    })
    const onDiagnostic = jest.fn(() => delivery)
    provider = create(onDiagnostic)
    try {
      await ready()
      failFetch()
      await expect(provider.onClose()).resolves.toBeUndefined()
      expect(onDiagnostic).toHaveBeenCalledTimes(2)
    } finally {
      completeDelivery()
    }
  })

  it('does no measurement work without a callback', async () => {
    provider = new DatadogNodeServerProvider({
      exposureChannel: channel('test:sdk-diagnostics-disabled') as Channel<ExposureEvent>,
    })
    await ready()
    failFetch()
    await provider.onClose()
    expect(performance.now).not.toHaveBeenCalled()
    expect(observations).toEqual([])
  })

  it('rejects an initialization timestamp that moves behind its start', async () => {
    const pending = provider.initialize()
    jest.setSystemTime(NOW - 1)
    provider.setConfiguration(configuration)
    await pending
    expect(observations).toEqual([])
  })

  for (const duration of [86_400_000, 86_400_001]) {
    it(`enforces the duration limit at ${duration}ms`, async () => {
      const pending = provider.initialize()
      monotonic = duration
      jest.setSystemTime(NOW + duration)
      provider.setConfiguration(configuration)
      await pending
      expect(observations).toHaveLength(duration === 86_400_000 ? 1 : 0)
    })
  }

  for (const timestamp of [946_684_799_999, 946_684_800_000, 4_102_444_800_000, 4_102_444_800_001]) {
    it(`enforces the timestamp bounds at ${timestamp}`, async () => {
      jest.setSystemTime(timestamp)
      await ready()
      expect(observations).toHaveLength(timestamp >= 946_684_800_000 && timestamp <= 4_102_444_800_000 ? 1 : 0)
    })
  }
})
