import { createHttpRequest } from '@datadog/browser-core'
import type { Logger } from '@openfeature/web-sdk'
import { ProviderStatus } from '@openfeature/web-sdk'
import * as cacheHelpers from '../../src/cache/helpers'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogProvider } from '../../src/openfeature/provider'
import precomputedResponse from '../data/precomputed-v1.json'

const mockSend = jest.fn()
jest.mock('@datadog/browser-core', () => ({
  ...jest.requireActual('@datadog/browser-core'),
  createHttpRequest: jest.fn(() => ({ send: mockSend, sendOnExit: mockSend })),
}))

const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const success = () => Promise.resolve(new Response(JSON.stringify(precomputedResponse), { status: 200 }))
const failure = () => Promise.reject(new TypeError('private network failure details'))
const options: FlaggingInitConfiguration = {
  clientToken: 'test-token',
  applicationId: 'app-1',
  env: 'test',
  debugMode: true,
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}

function eventTypes(provider: DatadogProvider): string[] {
  provider.onClose()
  return mockSend.mock.calls.flatMap(([request]) =>
    request.data.split('\n').map((line: string) => JSON.parse(line).payload.event_type)
  )
}

describe('provider diagnostics', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    jest.spyOn(console, 'log').mockImplementation(() => {})
    jest.spyOn(IndexedDBFlagsCache.prototype, 'get').mockResolvedValue(undefined)
    jest.spyOn(IndexedDBFlagsCache.prototype, 'set').mockImplementation(() => {})
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('is disabled by default and does not allocate telemetry when evaluation reporting is disabled', async () => {
    const provider = new DatadogProvider({ ...options, debugMode: undefined, flagConfigurationFetch: success })
    await provider.initialize()
    expect(createHttpRequest).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
    expect(eventTypes(provider)).toEqual([])
  })

  it('emits real startup evidence without any flag evaluation or RUM', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    await provider.onContextChange({}, { targetingKey: 'second-context' })
    expect(eventTypes(provider)).toEqual(['sdk_init_started', 'configuration_received', 'provider_ready'])
  })

  it('reports a fetch error and failed initialization when no configuration is available', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: failure })
    await expect(provider.initialize()).rejects.toThrow()
    expect(eventTypes(provider)).toEqual(['sdk_init_started', 'provider_error', 'init_failed'])
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain('private network failure details')
  })

  it('reports fetch failure with stale fallback, without claiming fresh readiness', async () => {
    const fetch = jest.fn().mockImplementationOnce(success).mockImplementation(failure)
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    await provider.initialize()
    await provider.onContextChange({}, {})
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(eventTypes(provider)).toEqual([
      'sdk_init_started',
      'configuration_received',
      'provider_ready',
      'provider_error',
    ])
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
    expect(eventTypes(provider)).toEqual(['sdk_init_started', 'configuration_received', 'provider_ready'])
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
    expect(eventTypes(provider)).toEqual(['sdk_init_started', 'provider_error'])
  })

  it('reports malformed configuration without a successful readiness event', async () => {
    const provider = new DatadogProvider({
      ...options,
      flagConfigurationFetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    })
    await provider.initialize()
    expect(eventTypes(provider)).toEqual(['sdk_init_started', 'provider_error', 'init_failed'])
  })

  it('reports timeout once, without aborting a slow successful initialization', async () => {
    let finish: ((response: Response) => void) | undefined
    const fetch: typeof globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetch })
    const initializing = provider.initialize()
    await jest.advanceTimersByTimeAsync(31_000)
    finish?.(new Response(JSON.stringify(precomputedResponse), { status: 200 }))
    await initializing
    expect(eventTypes(provider)).toEqual([
      'sdk_init_started',
      'init_timeout',
      'configuration_received',
      'provider_ready',
    ])
  })

  it('logs evaluation details locally without changing return values or uploading flag data', async () => {
    const provider = new DatadogProvider({ ...options, flagConfigurationFetch: success })
    await provider.initialize()
    const details = provider.resolveBooleanEvaluation('missing-test-flag', true, {}, logger)
    expect(console.log).toHaveBeenCalledWith(
      '[Datadog Feature Flags]',
      'Evaluation details',
      JSON.stringify({ flagKey: 'missing-test-flag', ...details })
    )
    eventTypes(provider)
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain('missing-test-flag')
    expect(details.value).toBe(true)
  })
})
