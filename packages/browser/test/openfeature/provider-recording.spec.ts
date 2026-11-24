import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { type EvaluationDetails, type FlagValue, OpenFeature } from '@openfeature/web-sdk'
import SimpleAssignmentCache from '../../src/cache/simple-assignment-cache'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  type DatadogCoreProviderConfiguration,
  DatadogProvider,
  type ExposureEvaluation,
  ExposureHook,
  type FlaggingInitConfiguration,
} from '../../src/rules-based'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const tracking = {
  clientToken: 'recording-token',
  applicationId: 'recording-app',
  env: 'test',
  site: INTAKE_SITE_STAGING,
  flagEvaluationTrackingInterval: 1000,
}
const context = { targetingKey: 'user', country: 'US' }

describe('per-provider recording options', () => {
  const rumEvaluation = jest.fn()
  let fetchMock: jest.Mock
  let originalFetch: typeof globalThis.fetch
  // Both cache backends, memory and IndexedDB, read and write through these.
  let cacheSet: jest.SpyInstance
  let cacheHas: jest.SpyInstance
  let evaluations: ExposureEvaluation[]

  const requests = (endpoint: string) => fetchMock.mock.calls.filter(([url]) => url.toString().includes(endpoint))
  const exposureRequests = () => requests('exposures')
  // The same intake also receives SDK lifecycle diagnostics, which are not evaluation telemetry.
  const evaluationRequests = () =>
    requests('flagevaluation')
      .flatMap(([, init]) => String(init.body).trim().split('\n'))
      .map((line) => JSON.parse(line))
      .filter((event) => event.type !== 'sdk_diagnostic')
  const flush = async () => {
    jest.advanceTimersByTime(31_000)
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(async () => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
    rumEvaluation.mockReset()
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = { addFeatureFlagEvaluation: rumEvaluation }
    cacheSet = jest.spyOn(SimpleAssignmentCache.prototype, 'set')
    cacheHas = jest.spyOn(SimpleAssignmentCache.prototype, 'has')
    evaluations = []
    await OpenFeature.clearProviders()
    OpenFeature.clearHooks()
    OpenFeature.addHooks(new ExposureHook((evaluation) => evaluations.push(evaluation)))
  })

  afterEach(async () => {
    OpenFeature.clearHooks()
    await OpenFeature.clearProviders()
    jest.restoreAllMocks()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  describe('DatadogProvider', () => {
    function createProvider(options: Partial<FlaggingInitConfiguration> = {}) {
      return new DatadogProvider({
        ...tracking,
        flagConfigurationFetch: jest
          .fn()
          .mockResolvedValue({ ok: true, text: async () => JSON.stringify(precomputedResponse) }),
        ...options,
      })
    }

    async function evaluate(domain: string, provider: DatadogProvider) {
      await OpenFeature.setProviderAndWait(domain, provider, context)
      const details = OpenFeature.getClient(domain).getStringDetails('string-flag', 'default')
      await flush()
      return details
    }

    function expectAssignedValue(details: EvaluationDetails<FlagValue>) {
      expect(details).toMatchObject({ value: 'red', variant: 'variation-123', reason: 'TARGETING_MATCH' })
      expect(details.errorCode).toBeUndefined()
    }

    it('records exposures and evaluation telemetry by default', async () => {
      const details = await evaluate('defaults', createProvider())

      expectAssignedValue(details)
      expect(exposureRequests()).toHaveLength(1)
      expect(evaluationRequests()).toHaveLength(1)
      expect(rumEvaluation).toHaveBeenCalledWith('string-flag', 'variation-123')
      expect(cacheSet).toHaveBeenCalled()
      expect(evaluations).toHaveLength(1)
      expect(evaluations[0].isExposure()).toBe(true)
      expect(evaluations[0].shouldSend()).toBe(true)
    })

    it('evaluates without an exposure when recordExposures is false', async () => {
      const details = await evaluate('no-exposures', createProvider({ recordExposures: false }))

      expectAssignedValue(details)
      expect(exposureRequests()).toHaveLength(0)
      expect(cacheSet).not.toHaveBeenCalled()
      expect(cacheHas).not.toHaveBeenCalled()
      expect(evaluations).toHaveLength(1)
      expect(evaluations[0].isExposure()).toBe(false)
      expect(evaluations[0].isCacheHit()).toBe(false)
      expect(evaluations[0].shouldSend()).toBe(false)
      expect(evaluations[0].allocation).toBe('allocation-123')
      expect(evaluationRequests()).toHaveLength(1)
      expect(rumEvaluation).toHaveBeenCalledWith('string-flag', 'variation-123')
    })

    it('evaluates without evaluation telemetry when trackEvaluations is false', async () => {
      const details = await evaluate('no-evaluations', createProvider({ trackEvaluations: false }))

      expectAssignedValue(details)
      expect(evaluationRequests()).toHaveLength(0)
      expect(rumEvaluation).not.toHaveBeenCalled()
      expect(exposureRequests()).toHaveLength(1)
      expect(evaluations[0].shouldSend()).toBe(true)
    })

    it('records nothing when both are false', async () => {
      const details = await evaluate(
        'peeking',
        createProvider({ recordExposures: false, trackEvaluations: false })
      )

      expectAssignedValue(details)
      expect(exposureRequests()).toHaveLength(0)
      expect(evaluationRequests()).toHaveLength(0)
      expect(rumEvaluation).not.toHaveBeenCalled()
      expect(cacheSet).not.toHaveBeenCalled()
      expect(evaluations[0].isExposure()).toBe(false)
    })

    it('still uses the RUM user for targeting when trackEvaluations is false', async () => {
      getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
        addFeatureFlagEvaluation: rumEvaluation,
        getUser: () => ({ id: 'rum-user' }),
      }
      const fetchConfiguration = jest
        .fn()
        .mockResolvedValue({ ok: true, text: async () => JSON.stringify(precomputedResponse) })
      const provider = createProvider({ trackEvaluations: false, flagConfigurationFetch: fetchConfiguration })
      await OpenFeature.setProviderAndWait('rum-user', provider, {})

      expect(JSON.parse(fetchConfiguration.mock.calls[0][1].body).data.attributes.subject.targeting_key).toBe(
        'rum-user'
      )
    })

    it('does not re-enable tracking turned off by the tracking options', async () => {
      await evaluate(
        'narrowing',
        createProvider({
          trackExposures: false,
          enableFlagEvaluationTracking: false,
          enableRumFeatureFlagTracking: false,
          recordExposures: true,
          trackEvaluations: true,
        })
      )

      expect(exposureRequests()).toHaveLength(0)
      expect(evaluationRequests()).toHaveLength(0)
      expect(rumEvaluation).not.toHaveBeenCalled()
    })

    it('leaves the exposure to a later evaluation through a default provider', async () => {
      await evaluate('peek', createProvider({ recordExposures: false, trackEvaluations: false }))
      expect(exposureRequests()).toHaveLength(0)
      expect(cacheSet).not.toHaveBeenCalled()

      await evaluate('record', createProvider())
      expect(exposureRequests()).toHaveLength(1)
      expect(evaluations.map((evaluation) => evaluation.shouldSend())).toEqual([false, true])
    })
  })

  describe('DatadogCoreProvider with shared tracking hooks', () => {
    async function setup() {
      const exposureLogging = createDatadogExposureLoggingHook(tracking)
      await exposureLogging.initialize()
      const evaluationLogging = createDatadogEvaluationLoggingHook(tracking)
      await evaluationLogging.initialize()
      OpenFeature.addHooks(...exposureLogging.hooks, ...evaluationLogging.hooks, ...createDatadogRumTrackingHook().hooks)
      const createProvider = async (domain: string, options: DatadogCoreProviderConfiguration = {}) => {
        const provider = new DatadogCoreProvider({ exposureCache: exposureLogging.exposureCache, ...options })
        provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
        await OpenFeature.setProviderAndWait(domain, provider, context)
        return OpenFeature.getClient(domain)
      }
      const shutdown = async () => {
        await exposureLogging.shutdown()
        await evaluationLogging.shutdown()
      }
      return { createProvider, shutdown }
    }

    it('records through the shared hooks by default', async () => {
      const { createProvider, shutdown } = await setup()
      const details = (await createProvider('core-default')).getBooleanDetails('test-flag', false)
      await flush()

      expect(details).toMatchObject({ value: true, variant: 'on' })
      expect(cacheSet).toHaveBeenCalled()
      expect(exposureRequests()).toHaveLength(1)
      expect(evaluationRequests()).toHaveLength(1)
      expect(rumEvaluation).toHaveBeenCalledWith('test-flag', 'on')
      expect(evaluations[0].shouldSend()).toBe(true)
      await shutdown()
    })

    it('does not touch the shared exposure cache when recordExposures is false', async () => {
      const { createProvider, shutdown } = await setup()
      const details = (await createProvider('core-no-exposures', { recordExposures: false })).getBooleanDetails(
        'test-flag',
        false
      )
      await flush()

      expect(details).toMatchObject({ value: true, variant: 'on' })
      expect(cacheSet).not.toHaveBeenCalled()
      expect(cacheHas).not.toHaveBeenCalled()
      expect(exposureRequests()).toHaveLength(0)
      expect(evaluations[0].isExposure()).toBe(false)
      expect(evaluationRequests()).toHaveLength(1)
      expect(rumEvaluation).toHaveBeenCalledWith('test-flag', 'on')
      await shutdown()
    })

    it('suppresses the shared evaluation hooks when trackEvaluations is false', async () => {
      const { createProvider, shutdown } = await setup()
      ;(await createProvider('core-no-evaluations', { trackEvaluations: false })).getBooleanDetails(
        'test-flag',
        false
      )
      await flush()

      expect(evaluationRequests()).toHaveLength(0)
      expect(rumEvaluation).not.toHaveBeenCalled()
      expect(exposureRequests()).toHaveLength(1)
      await shutdown()
    })

    it('leaves the exposure to a later evaluation through a default provider', async () => {
      const { createProvider, shutdown } = await setup()
      const peek = await createProvider('core-peek', { recordExposures: false, trackEvaluations: false })
      const record = await createProvider('core-record')

      expect(peek.getBooleanValue('test-flag', false)).toBe(true)
      await flush()
      expect(cacheSet).not.toHaveBeenCalled()
      expect(exposureRequests()).toHaveLength(0)
      expect(evaluationRequests()).toHaveLength(0)

      expect(record.getBooleanValue('test-flag', false)).toBe(true)
      await flush()
      expect(cacheSet).toHaveBeenCalledTimes(1)
      expect(exposureRequests()).toHaveLength(1)
      expect(evaluationRequests()).toHaveLength(1)
      expect(evaluations.map((evaluation) => evaluation.shouldSend())).toEqual([false, true])
      await shutdown()
    })
  })
})
