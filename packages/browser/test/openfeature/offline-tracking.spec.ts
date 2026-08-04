import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import {
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
  type ExposureEvent,
  type FlagsConfiguration,
} from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/rules-based'
import { OpenFeature } from '@openfeature/web-sdk'
import { DatadogOfflineProvider } from '../../src/openfeature/offline-provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import rulesWire from '../data/rules-v1-wire.json'

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))

const precomputedConfiguration: FlagsConfiguration = {
  precomputed: {
    context: { targetingKey: 'static-user', plan: 'free' },
    response: {
      data: {
        attributes: {
          createdAt: '2026-07-06T23:01:56.822Z',
          flags: {
            'static-flag': {
              allocationKey: 'static-allocation',
              variationKey: 'static-variation',
              variationType: 'string',
              variationValue: 'static-value',
              reason: 'TARGETING_MATCH',
              doLog: true,
            },
          },
        },
      },
    },
  },
}

const tracking = {
  clientToken: 'test-client-token',
  applicationId: 'test-app-id',
  env: 'test',
  site: INTAKE_SITE_STAGING,
  flagEvaluationTrackingInterval: 1000,
}

describe('DatadogOfflineProvider tracking', () => {
  const rumEvaluation = jest.fn()
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  beforeAll(() => {
    originalFetch = global.fetch
    jest.useFakeTimers()
  })

  afterAll(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  beforeEach(async () => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock
    rumEvaluation.mockReset()
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = { addFeatureFlagEvaluation: rumEvaluation }
    localStorage.clear()
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()
  })

  afterEach(() => {
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    Reflect.deleteProperty(globalThis, 'chrome')
  })

  it('does not track or create network activity by default', async () => {
    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    expect(provider.hooks).toEqual([])

    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'static-user', plan: 'free' })
    OpenFeature.getClient().getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(rumEvaluation).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the matching OpenFeature context for all opt-in tracking', async () => {
    const provider = new DatadogOfflineProvider({ tracking })
    provider.setConfiguration(precomputedConfiguration)
    expect(provider.hooks).toHaveLength(3)

    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'static-user', plan: 'free' })
    OpenFeature.getClient().getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(rumEvaluation).toHaveBeenCalledWith('static-flag', 'static-variation')

    const exposureRequest = findRequest('exposures')
    expect(parseRequestBody(exposureRequest)).toMatchObject({
      subject: { id: 'static-user', attributes: { plan: 'free' } },
    })

    const evaluationRequest = findRequest('flagevaluation')
    expect(parseRequestBody(evaluationRequest)).toMatchObject({
      targeting_key: 'static-user',
      context: { evaluation: { plan: 'free' } },
    })
  })

  it('tracks rules-based evaluations with the supplied context', async () => {
    const provider = new DatadogOfflineProvider({ tracking })
    provider.setConfiguration(rulesConfiguration)
    await OpenFeature.setContext({ targetingKey: 'rules-user', country: 'US' })
    await OpenFeature.setProviderAndWait(provider)

    OpenFeature.getClient().getBooleanValue('test-flag', false)
    jest.advanceTimersByTime(31_000)

    expect(rumEvaluation).toHaveBeenCalledWith('test-flag', 'on')
    expect(parseRequestBody(findRequest('exposures'))).toMatchObject({
      flag: { key: 'test-flag' },
      allocation: { key: 'allocation' },
      variant: { key: 'on' },
      subject: { id: 'rules-user', attributes: { country: 'US' } },
      timestamp: expect.any(Number),
    })
    expect(parseRequestBody(findRequest('flagevaluation'))).toMatchObject({
      flag: { key: 'test-flag' },
      allocation: { key: 'allocation' },
      variant: { key: 'on' },
      targeting_key: 'rules-user',
      context: { evaluation: { country: 'US' } },
      timestamp: expect.any(Number),
      first_evaluation: expect.any(Number),
      last_evaluation: expect.any(Number),
    })
  })

  it('does not emit exposures when evaluation returns a default', async () => {
    const provider = new DatadogOfflineProvider({
      tracking: {
        ...tracking,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      },
    })
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'static-user', plan: 'free' })

    OpenFeature.getClient().getStringValue('missing-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.some(([url]) => url.toString().includes('exposures'))).toBe(false)
  })

  it('clears exposure deduplication when configuration is replaced', async () => {
    const provider = new DatadogOfflineProvider({
      tracking: {
        ...tracking,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      },
    })
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'static-user', plan: 'free' })
    const client = OpenFeature.getClient()

    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)
    provider.setConfiguration(precomputedConfiguration)
    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))).toHaveLength(2)
  })

  it('does not rehydrate stale exposures when configuration is replaced during cache initialization', async () => {
    const staleExposure: ExposureEvent = {
      allocation: { key: 'static-allocation' },
      flag: { key: 'static-flag' },
      variant: { key: 'static-variation' },
      subject: { id: 'static-user', attributes: { plan: 'free' } },
    }
    const staleEntries = {
      [assignmentCacheKeyToString(staleExposure)]: assignmentCacheValueToString(staleExposure),
    }
    let notifyReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      notifyReadStarted = resolve
    })
    let resolveInitialRead!: (entries: Record<string, string>) => void
    const storage = {
      get: jest.fn(
        () =>
          new Promise<Record<string, string>>((resolve) => {
            resolveInitialRead = resolve
            notifyReadStarted()
          })
      ),
      set: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    } as unknown as chrome.storage.StorageArea
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { storage: { local: storage } },
    })

    const provider = new DatadogOfflineProvider({
      tracking: {
        ...tracking,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      },
    })
    provider.setConfiguration(precomputedConfiguration)
    const registration = OpenFeature.setProviderAndWait(provider, { targetingKey: 'static-user', plan: 'free' })
    await readStarted

    provider.setConfiguration(precomputedConfiguration)
    resolveInitialRead(staleEntries)
    await registration

    OpenFeature.getClient().getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))).toHaveLength(1)
  })

  function findRequest(endpoint: string): RequestInit {
    const call = fetchMock.mock.calls.find(([url]) => url.toString().includes(endpoint))
    expect(call).toBeDefined()
    return call[1]
  }

  function parseRequestBody(request: RequestInit): unknown {
    expect(typeof request.body).toBe('string')
    return JSON.parse((request.body as string).trim())
  }
})
