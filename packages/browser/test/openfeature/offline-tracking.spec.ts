import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import {
  assignmentCacheKeyToString,
  assignmentCacheValueToString,
  type ExposureEvent,
  type FlagsConfiguration,
} from '@datadog/flagging-core'
import { OpenFeature } from '@openfeature/web-sdk'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  createDatadogTrackingHooks,
  DatadogOfflineProvider,
} from '../../src/rules-based'
import rulesWire from '../data/rules-v1-wire.json'

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))
const DOMAIN = 'datadog-offline-tracking'

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

function createAllDatadogTrackingHooks() {
  const exposureLogging = createDatadogExposureLoggingHook(tracking)
  return createDatadogTrackingHooks(
    createDatadogRumTrackingHook(),
    createDatadogEvaluationLoggingHook(tracking),
    exposureLogging
  )
}

function createExposureOnlyTracking() {
  const exposureLogging = createDatadogExposureLoggingHook(tracking)
  return {
    trackingHooks: createDatadogTrackingHooks(exposureLogging),
  }
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
    OpenFeature.getClient().clearHooks()
    OpenFeature.getClient(DOMAIN).clearHooks()
  })

  afterEach(() => {
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    Reflect.deleteProperty(globalThis, 'chrome')
  })

  it('does not track or create network activity by default', async () => {
    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)

    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })
    OpenFeature.getClient(DOMAIN).getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(rumEvaluation).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the matching OpenFeature context for all opt-in tracking', async () => {
    const trackingHooks = createAllDatadogTrackingHooks()
    await trackingHooks.initialize()

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    expect(trackingHooks.hooks).toHaveLength(3)

    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)
    client.getStringValue('static-flag', 'default')
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
    const trackingHooks = createAllDatadogTrackingHooks()
    await trackingHooks.initialize()

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(rulesConfiguration)
    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'rules-user', country: 'US' })

    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)
    client.getBooleanValue('test-flag', false)
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

  it('supports composing individual tracking hooks', () => {
    expect(createDatadogTrackingHooks(createDatadogRumTrackingHook()).hooks).toHaveLength(1)
    expect(createDatadogTrackingHooks(createDatadogEvaluationLoggingHook(tracking)).hooks).toHaveLength(1)
    expect(createExposureOnlyTracking().trackingHooks.hooks).toHaveLength(1)
    expect(createDatadogTrackingHooks().hooks).toHaveLength(0)
  })

  it('keeps tracking initialization as a no-op when hooks have no lifecycle', async () => {
    const trackingHooks = createDatadogTrackingHooks(
      createDatadogRumTrackingHook(),
      createDatadogEvaluationLoggingHook(tracking)
    )

    await expect(trackingHooks.initialize()).resolves.toBeUndefined()
  })

  it('does not emit exposures when evaluation returns a default', async () => {
    const { trackingHooks } = createExposureOnlyTracking()
    await trackingHooks.initialize()

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })

    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)
    client.getStringValue('missing-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.some(([url]) => url.toString().includes('exposures'))).toBe(false)
  })

  it('emits exposures again when the offline provider configuration identity changes', async () => {
    const { trackingHooks } = createExposureOnlyTracking()
    await trackingHooks.initialize()

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)

    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    provider.setConfiguration(precomputedConfigurationWithCreatedAt('2026-07-07T00:00:00.000Z'))
    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))).toHaveLength(2)
  })

  it('keeps exposure deduplication when the offline provider configuration identity is unchanged', async () => {
    const { trackingHooks } = createExposureOnlyTracking()
    await trackingHooks.initialize()

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })
    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)

    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    provider.setConfiguration(precomputedConfigurationWithCreatedAt('2026-07-06T23:01:56.822Z'))
    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))).toHaveLength(1)
  })

  it('does not let legacy exposure cache entries suppress offline provider exposures', async () => {
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

    const { trackingHooks } = createExposureOnlyTracking()
    const trackingInitialization = trackingHooks.initialize()
    await readStarted
    resolveInitialRead(staleEntries)
    await trackingInitialization

    const provider = new DatadogOfflineProvider()
    provider.setConfiguration(precomputedConfiguration)
    await OpenFeature.setProviderAndWait(DOMAIN, provider, { targetingKey: 'static-user', plan: 'free' })

    const client = OpenFeature.getClient(DOMAIN)
    client.addHooks(...trackingHooks.hooks)
    client.getStringValue('static-flag', 'default')
    jest.advanceTimersByTime(31_000)

    expect(fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))).toHaveLength(1)
  })

  function precomputedConfigurationWithCreatedAt(createdAt: string): FlagsConfiguration {
    const precomputed = precomputedConfiguration.precomputed!
    return {
      precomputed: {
        ...precomputed,
        response: {
          data: {
            attributes: {
              ...precomputed.response.data.attributes,
              createdAt,
            },
          },
        },
      },
    }
  }

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
