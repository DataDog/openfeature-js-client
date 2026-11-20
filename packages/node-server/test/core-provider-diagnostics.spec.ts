import { performance } from 'node:perf_hooks'
import type { FlagsConfiguration } from '@datadog/flagging-core'
import { OpenFeature, ServerProviderStatus } from '@openfeature/server-sdk'
import precomputedWire from '../../browser/test/data/precomputed-v1-wire.json'
import rulesWire from '../../browser/test/data/rules-v1-wire.json'
import { diagnosticRecords } from '../../browser/test/openfeature/diagnostic-contract'
import type { DatadogNodeServerProviderOptions } from '../src/provider'
import {
  configurationFromString,
  DatadogCoreProvider,
  type DatadogCoreProviderOptions,
  type SDKDiagnostic,
} from '../src/rules-based'

jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn() } }))

const NOW = Date.UTC(2026, 10, 17)
const domain = 'core-provider-diagnostics'
const context = { targetingKey: 'subject', country: 'US' }

describe('core provider SDK diagnostics', () => {
  let provider: DatadogCoreProvider | undefined
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
  })

  afterEach(async () => {
    await provider?.onClose()
    await OpenFeature.clearProviders()
    provider = undefined
    for (const observation of observations) {
      diagnosticRecords(
        JSON.stringify({
          type: 'sdk_diagnostic',
          schema_version: 1,
          payload: {
            ...observation,
            sdk_name: 'dd-trace-js',
            sdk_version: '1.0.0',
            service_id: 'offline-service',
            environment: 'test',
          },
        })
      )
    }
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function configuration(): FlagsConfiguration {
    return configurationFromString(JSON.stringify(rulesWire))
  }

  function create(options: DatadogCoreProviderOptions = {}, input = configuration()) {
    provider = new DatadogCoreProvider(input, {
      onDiagnostic: (observation) => {
        observations.push(observation)
      },
      ...options,
    })
    return provider
  }

  function failFetch() {
    provider!.reportConfigurationFetchStart()
    provider!.reportConfigurationFetchResult(false)
  }

  async function advance(ms: number) {
    monotonic += ms
    await jest.advanceTimersByTimeAsync(ms)
  }

  it.each(['rules', 'precomputed'] as const)(
    'reports %s construction synchronously without fetching or hooks',
    (format) => {
      const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'))
      const input = configurationFromString(JSON.stringify(format === 'rules' ? rulesWire : precomputedWire))
      jest.mocked(performance.now).mockReturnValueOnce(5).mockReturnValueOnce(10).mockReturnValueOnce(20)
      create({}, input)
      expect(observations).toEqual([
        {
          timestamp: NOW,
          event_type: 'sdk_initialization',
          initialization: {
            started_at_ms: NOW,
            duration_ms: 15,
            outcome: 'ready',
            final: true,
            milestones: { configuration_received: { elapsed_ms: 5 }, provider_ready: { elapsed_ms: 15 } },
          },
        },
      ])
      expect('initialize' in provider!).toBe(false)
      expect(provider!.hooks).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('keeps OpenFeature immediately ready for the first invocation', async () => {
    const instance = create()
    OpenFeature.setProvider(domain, instance)
    const client = OpenFeature.getClient(domain)
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    expect(observations).toHaveLength(1)
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(observations).toHaveLength(1)
  })

  it('reports invalid construction once and preserves the constructor error', () => {
    const onDiagnostic: DatadogNodeServerProviderOptions['onDiagnostic'] = (observation) => {
      observations.push(observation)
    }
    expect(() => new DatadogCoreProvider({}, { onDiagnostic })).toThrow(
      new TypeError('DatadogCoreProvider requires a valid rules-based or precomputed configuration')
    )
    expect(observations).toEqual([
      {
        timestamp: NOW,
        event_type: 'sdk_initialization',
        error_code: 'INIT_FAILED',
        initialization: { started_at_ms: NOW, duration_ms: 0, outcome: 'failed', final: true, milestones: {} },
      },
    ])
  })

  it('does no measurement without a callback, including refresh reporting and evaluation', async () => {
    const instance = create({ onDiagnostic: undefined })
    instance.reportConfigurationFetchStart()
    instance.reportConfigurationFetchResult(false)
    OpenFeature.setProvider(domain, instance)
    await OpenFeature.getClient(domain).getBooleanValue('test-flag', false, context)
    await instance.onClose()
    expect(performance.now).not.toHaveBeenCalled()
    expect(observations).toEqual([])
  })

  it('reports a sustained refresh outage after cooldown and retains working configuration', async () => {
    const instance = create()
    failFetch()
    await advance(10_000)
    instance.reportConfigurationFetchResult(true)
    await advance(10_000)
    failFetch()
    await advance(39_999)
    failFetch()
    expect(observations).toHaveLength(2)
    await advance(1)
    failFetch()
    await advance(60_000)
    failFetch()
    expect(observations.map((observation) => observation.event_type)).toEqual([
      'sdk_initialization',
      'provider_error',
      'provider_error',
    ])
    OpenFeature.setProvider(domain, instance)
    await expect(OpenFeature.getClient(domain).getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    instance.reportConfigurationFetchResult(true)
    failFetch()
    expect(observations).toHaveLength(4)
  })

  it('ignores a cancelled refresh when the caller does not report failure', () => {
    const instance = create()
    instance.reportConfigurationFetchStart()
    instance.reportConfigurationFetchStart()
    instance.reportConfigurationFetchResult(true)
    expect(observations).toHaveLength(1)
    failFetch()
    expect(observations[1]).toMatchObject({ event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED' })
  })

  it('does not report configuration replacement or evaluation errors as fetch failures', async () => {
    const instance = create()
    instance.setConfiguration(configuration())
    expect(() => instance.setConfiguration({})).toThrow(TypeError)
    OpenFeature.setProvider(domain, instance)
    await expect(OpenFeature.getClient(domain).getBooleanDetails('missing', false, context)).resolves.toMatchObject({
      errorCode: 'FLAG_NOT_FOUND',
    })
    expect(observations).toHaveLength(1)
  })

  it.each(['synchronous', 'asynchronous'] as const)(
    'contains %s callback errors and preserves invalid-input errors',
    async (kind) => {
      const onDiagnostic = jest.fn(
        kind === 'synchronous'
          ? () => {
              throw new Error('delivery failed')
            }
          : async () => {
              throw new Error('delivery failed')
            }
      )
      create({ onDiagnostic })
      expect(failFetch).not.toThrow()
      await expect(provider!.onClose()).resolves.toBeUndefined()
      expect(() => new DatadogCoreProvider({}, { onDiagnostic })).toThrow(TypeError)
      await advance(0)
      expect(onDiagnostic).toHaveBeenCalledTimes(3)
    }
  )

  it('does not await delivery during construction or close', async () => {
    let finishDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve
    })
    const onDiagnostic = jest.fn(() => delivery)
    try {
      create({ onDiagnostic })
      expect(onDiagnostic).toHaveBeenCalledTimes(1)
      await expect(provider!.onClose()).resolves.toBeUndefined()
    } finally {
      finishDelivery()
    }
  })

  it('stops diagnostics permanently after close without adding an incomplete event', async () => {
    const instance = create()
    await instance.onClose()
    await instance.onClose()
    failFetch()
    instance.reportConfigurationFetchResult(true)
    instance.setConfiguration(configuration())
    expect(observations).toHaveLength(1)
  })
})
