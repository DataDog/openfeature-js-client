import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { OpenFeature } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { type ExposureEvaluation, ExposureHook } from '../../src/openfeature/exposure-hook'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'

describe('exposure cache verdict', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch
  let warnSpy: jest.SpyInstance

  const context = { targetingKey: 'verdict-user' }
  const baseProviderConfig: FlaggingInitConfiguration = {
    clientToken: 'test-client-token',
    applicationId: 'test-app-id',
    env: 'test',
    site: INTAKE_SITE_STAGING,
  }

  const exposureCalls = () => fetchMock.mock.calls.filter(([url]) => url.toString().includes('exposures'))
  const exposureEvents = () =>
    exposureCalls().flatMap(([, request]) =>
      (request.body as string)
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    )
  const triggerBatch = () => jest.advanceTimersByTime(31000)

  interface FlagOverrides {
    variationKey?: string
    variationValue?: boolean
    serialId?: number
    features?: Array<{ key: string; value: string | number | boolean; destinations: string[] }>
    doLog?: boolean
  }

  function precomputedResponse(flagOverrides: FlagOverrides = {}, createdAt = '2026-10-26T00:00:00Z') {
    return {
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            createdAt,
            flags: {
              'holdout-flag': {
                allocationKey: 'holdout-allocation',
                variationKey: 'control',
                variationType: 'BOOLEAN',
                variationValue: false,
                reason: 'TARGETING_MATCH',
                doLog: true,
                serialId: 1001,
                features: [
                  { key: 'holdout.key', value: '06ad', destinations: ['HOOK'] },
                  { key: 'holdout.assignment_group', value: 'status_quo', destinations: ['HOOK'] },
                  { key: 'exposure.only', value: 'exposed', destinations: ['EXPOSURE'] },
                ],
                ...flagOverrides,
              },
              'silent-flag': {
                allocationKey: 'silent-allocation',
                variationKey: 'on',
                variationType: 'BOOLEAN',
                variationValue: true,
                reason: 'TARGETING_MATCH',
                doLog: false,
              },
            },
          },
        },
      }),
    }
  }

  async function startProvider(options: FlaggingInitConfiguration, response = precomputedResponse()) {
    fetchMock.mockImplementation((url: string) => {
      if (url.toString().includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      if (url.toString().includes('precompute-assignments')) {
        return Promise.resolve(response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    const provider = new DatadogProvider(options)
    await OpenFeature.setContext(context)
    await OpenFeature.setProviderAndWait(provider)
    return provider
  }

  beforeAll(() => {
    originalFetch = global.fetch
    fetchMock = jest.fn()
    global.fetch = fetchMock
    jest.useFakeTimers()
  })

  afterAll(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  beforeEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
    OpenFeature.clearHooks()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.indexedDB = new IDBFactory()
    // Provider shutdown flushes pending batches into fetch; drop those calls.
    await Promise.resolve()
    fetchMock.mockReset()
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('stamps one verdict per evaluation and deduplicates repeats', async () => {
    await startProvider(baseProviderConfig)
    const client = OpenFeature.getClient()

    const first = client.getBooleanDetails('holdout-flag', true)
    expect(first.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(first.flagMetadata?.__dd_feature).toBeUndefined()

    const second = client.getBooleanDetails('holdout-flag', true)
    expect(second.flagMetadata?.__dd_exposure_cache_hit).toBe(true)

    triggerBatch()
    expect(exposureEvents()).toEqual([
      expect.objectContaining({
        allocation: { key: 'holdout-allocation' },
        flag: { key: 'holdout-flag' },
        variant: { key: 'control' },
        serial_id: 1001,
      }),
    ])
  })

  it('treats a variant or serial id change as a new exposure', async () => {
    const provider = await startProvider(baseProviderConfig)
    const client = OpenFeature.getClient()

    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(false)

    fetchMock.mockImplementation((url: string) => {
      if (url.toString().includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      return Promise.resolve(precomputedResponse({ serialId: 1002 }))
    })
    await provider.onContextChange(context, context)
    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(true)

    fetchMock.mockImplementation((url: string) => {
      if (url.toString().includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      return Promise.resolve(precomputedResponse({ variationKey: 'treatment', variationValue: true }))
    })
    await provider.onContextChange(context, context)
    const changedVariant = client.getBooleanDetails('holdout-flag', true)
    expect(changedVariant.value).toBe(true)
    expect(changedVariant.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
  })

  it('does not stamp or record a failed evaluation', async () => {
    await startProvider(baseProviderConfig)
    const client = OpenFeature.getClient()

    const failed = client.getBooleanDetails('missing-flag', true)
    expect(failed.errorCode).toBe('FLAG_NOT_FOUND')
    expect(failed.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()

    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    triggerBatch()
    expect(exposureEvents()).toHaveLength(1)
  })

  it.each([
    ['trackExposures', { trackExposures: false }],
    ['enableExposureLogging', { enableExposureLogging: false }],
  ])('stops the Datadog send with %s off, but the verdict and cache keep working', async (_name, option) => {
    await startProvider({ ...baseProviderConfig, ...option })
    const client = OpenFeature.getClient()

    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(true)

    triggerBatch()
    expect(exposureCalls()).toHaveLength(0)
  })

  it('puts EXPOSURE features on the event but not in the cache entry', async () => {
    const provider = await startProvider(baseProviderConfig)
    const client = OpenFeature.getClient()

    client.getBooleanDetails('holdout-flag', true)
    triggerBatch()
    expect(exposureEvents()).toEqual([expect.objectContaining({ features: { 'exposure.only': 'exposed' } })])

    // A features change must not turn a repeat exposure into a new one.
    fetchMock.mockImplementation((url: string) => {
      if (url.toString().includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      return Promise.resolve(
        precomputedResponse({
          features: [{ key: 'exposure.only', value: 'changed', destinations: ['EXPOSURE'] }],
        })
      )
    })
    await provider.onContextChange(context, context)
    expect(client.getBooleanDetails('holdout-flag', true).flagMetadata?.__dd_exposure_cache_hit).toBe(true)
    triggerBatch()
    expect(exposureEvents()).toHaveLength(1)
  })

  it('does not stamp evaluations of allocations that do not log exposures', async () => {
    await startProvider(baseProviderConfig)
    const client = OpenFeature.getClient()

    expect(client.getBooleanDetails('silent-flag', false).flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
    triggerBatch()
    expect(exposureCalls()).toHaveLength(0)
  })

  it('deduplicates a nested evaluation for the online provider', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.toString().includes('precompute-assignments') ? precomputedResponse() : { ok: true, status: 200 }
      )
    )
    const rows: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((e) => rows.push(e)))
    const provider = new DatadogProvider(baseProviderConfig)
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()
    let nested = false
    client.addHooks({
      after: () => {
        if (!nested) {
          nested = true
          client.getBooleanDetails('holdout-flag', true)
        }
      },
    })

    expect(client.getBooleanDetails('holdout-flag', true).value).toBe(false)
    triggerBatch()
    expect(exposureEvents()).toHaveLength(1)
    expect(rows.map((row) => row.shouldSend()).sort()).toEqual([false, true])
  })

  it('gives the customer hook the same RUM subject as Datadog', async () => {
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
      getUser: () => ({ id: 'rum-subject', plan: 'pro' }),
      addFeatureFlagEvaluation: jest.fn(),
    } as unknown as DDRum
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.toString().includes('precompute-assignments') ? precomputedResponse() : { ok: true, status: 200 }
      )
    )
    const rows: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((e) => rows.push(e)))
    const provider = new DatadogProvider(baseProviderConfig)
    await OpenFeature.setProviderAndWait(provider)
    const details = OpenFeature.getClient().getBooleanDetails('holdout-flag', true)
    expect(details.errorCode).toBeUndefined()
    triggerBatch()
    expect(exposureEvents()[0].subject.id).toBe('rum-subject')
    expect(rows[0].targetingKey).toBe('rum-subject')
    expect(rows[0].context?.plan).toBe('pro')
  })

  it('warns once that enableExposureLogging is deprecated', () => {
    jest.isolateModules(() => {
      const { DatadogProvider: FreshProvider } = require('../../src/openfeature/provider')
      new (FreshProvider as typeof DatadogProvider)({ ...baseProviderConfig, enableExposureLogging: true })
      new (FreshProvider as typeof DatadogProvider)({ ...baseProviderConfig, enableExposureLogging: false })
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('enableExposureLogging is deprecated'))
  })

  it('lets trackExposures win over a deprecated enableExposureLogging', async () => {
    await startProvider({ ...baseProviderConfig, trackExposures: true, enableExposureLogging: false })
    const client = OpenFeature.getClient()

    client.getBooleanDetails('holdout-flag', true)
    triggerBatch()
    // trackExposures: true wins over the deprecated false, so the send still happens.
    expect(exposureEvents()).toEqual([expect.objectContaining({ flag: { key: 'holdout-flag' } })])
  })
})
