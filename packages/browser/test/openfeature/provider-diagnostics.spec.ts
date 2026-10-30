import { createHttpRequest } from '@datadog/browser-core'
import type { Logger } from '@openfeature/web-sdk'
import { OpenFeature, ProviderStatus } from '@openfeature/web-sdk'
import * as cacheHelpers from '../../src/cache/helpers'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../data/precomputed-v1.json'
import { diagnosticRecords } from './diagnostic-contract'

const mockSend = jest.fn()
jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  createHttpRequest: jest.fn(() => ({ send: mockSend, sendOnExit: mockSend })),
}))

const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const success = () => Promise.resolve(new Response(JSON.stringify(precomputedResponse), { status: 200 }))
const failure = () => Promise.reject(new TypeError('private network failure details'))
const baseOptions: FlaggingInitConfiguration = {
  clientToken: 'test-token',
  applicationId: 'app-1',
  env: 'test',
  trackExposures: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}

async function eventTypes(provider: DatadogProvider): Promise<string[]> {
  await provider.onClose()
  return mockSend.mock.calls.flatMap(([request]) =>
    diagnosticRecords(request.data).map((record) => record.payload.initialization?.outcome ?? record.payload.event_type)
  )
}

describe('provider diagnostics', () => {
  const options = baseOptions
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(IndexedDBFlagsCache.prototype, 'get').mockResolvedValue(undefined)
    jest.spyOn(IndexedDBFlagsCache.prototype, 'set').mockImplementation(() => {})
  })
  afterEach(() => {
    expect(console.log).not.toHaveBeenCalled()
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('emits telemetry even when evaluation, exposure and RUM reporting are disabled', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    expect(createHttpRequest).toHaveBeenCalledTimes(1)
    expect(await eventTypes(provider)).toEqual(['ready'])
  })

  it('finishes provider shutdown when the final diagnostic upload throws', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    mockSend.mockImplementationOnce(() => {
      throw new Error('transport unavailable')
    })
    await expect(provider.onClose()).resolves.toBeUndefined()
    expect(provider.status).toBe(ProviderStatus.NOT_READY)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('continues evaluation tracking when a closed provider is initialized again', async () => {
    const provider = new DatadogProvider({
      ...options,
      flagConfigurationFetch: success,
      enableFlagEvaluationTracking: true,
    })
    try {
      for (let run = 1; run <= 2; run++) {
        await OpenFeature.setProviderAndWait('telemetry-restart', provider)
        expect(OpenFeature.getClient('telemetry-restart').getBooleanValue('boolean-flag', false)).toBe(true)
        await OpenFeature.clearProviders()
        const evaluations = mockSend.mock.calls.flatMap(([request]) =>
          request.data
            .split('\n')
            .map((line: string) => JSON.parse(line))
            .filter((event: { flag?: unknown }) => event.flag)
        )
        expect(evaluations).toHaveLength(run)
        expect(jest.getTimerCount()).toBe(0)
      }
    } finally {
      await OpenFeature.clearProviders()
    }
  })

  it('emits real startup evidence without any flag evaluation or RUM', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    await provider.onContextChange({}, { targetingKey: 'second-context' })
    expect(await eventTypes(provider)).toEqual(['ready'])
  })

  it('reports a fetch error and failed initialization when no configuration is available', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: failure })
    await expect(provider.initialize()).rejects.toThrow()
    expect(await eventTypes(provider)).toEqual(['failed'])
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain('private network failure details')
  })

  it('reports fetch failure with stale fallback, without claiming fresh readiness', async () => {
    const fetch = jest.fn().mockImplementationOnce(success).mockImplementation(failure)
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    await provider.initialize()
    await provider.onContextChange({}, {})
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(await eventTypes(provider)).toEqual(['ready', 'provider_error'])
  })

  it('does not treat superseded configuration requests as failures', async () => {
    const fetch: typeof globalThis.fetch = jest
      .fn()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('Superseded', 'AbortError')))
          })
      )
      .mockImplementation(success)
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    const initializing = provider.initialize()
    await provider.onContextChange({}, { targetingKey: 'new' })
    await initializing
    expect(await eventTypes(provider)).toEqual(['ready'])
  })

  it('does not claim readiness when startup only recovers from persistent cache', async () => {
    jest.spyOn(cacheHelpers, 'hasIndexedDB').mockReturnValue(true)
    const warmup = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await warmup.initialize()
    const cached = jest.mocked(IndexedDBFlagsCache.prototype.set).mock.calls[0][0]
    await warmup.onClose()
    mockSend.mockClear()
    jest.mocked(IndexedDBFlagsCache.prototype.get).mockResolvedValue(cached)

    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: failure })
    await provider.initialize()
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(await eventTypes(provider)).toEqual(['cached_fallback'])
  })

  it('reports malformed configuration without a successful readiness event', async () => {
    const provider = new DatadogProvider({
      ...options,
      flagConfigurationFetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    })
    await expect(provider.initialize()).rejects.toThrow('Precomputed configuration response is missing data')
    expect(await eventTypes(provider)).toEqual(['failed'])
  })

  it('waits for a slow successful initialization without a timed report', async () => {
    let finish: ((response: Response) => void) | undefined
    const fetch: typeof globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    const initializing = provider.initialize()
    await jest.advanceTimersByTimeAsync(31_000)
    expect(mockSend).not.toHaveBeenCalled()
    finish?.(new Response(JSON.stringify(precomputedResponse), { status: 200 }))
    await initializing
    expect(await eventTypes(provider)).toEqual(['ready'])
  })

  it('does not log or upload flag data when evaluation reporting is disabled', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    const details = provider.resolveBooleanEvaluation('missing-test-flag', true, {}, logger)
    expect(console.log).not.toHaveBeenCalled()
    await eventTypes(provider)
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain('missing-test-flag')
    expect(details.value).toBe(true)
  })
})
