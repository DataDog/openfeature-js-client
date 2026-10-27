import { getGlobalObject, INTAKE_SITE_STAGING } from '@datadog/browser-core'
import { OpenFeature } from '@openfeature/web-sdk'
import { IDBFactory } from 'fake-indexeddb'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { type ExposureEvaluation, ExposureHook } from '../../src/openfeature/exposure-hook'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'

describe('ExposureHook', () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof global.fetch

  const context = { targetingKey: 'hook-user' }
  const baseProviderConfig: FlaggingInitConfiguration = {
    clientToken: 'test-client-token',
    applicationId: 'test-app-id',
    env: 'test',
    site: INTAKE_SITE_STAGING,
  }

  const precomputedResponse = () => ({
    ok: true,
    json: async () => ({
      data: {
        attributes: {
          createdAt: '2026-10-26T00:00:00Z',
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
                { key: 'holdout.should_include_in_holdout_analysis', value: false, destinations: ['HOOK'] },
                { key: 'exposure.only', value: 'exposed', destinations: ['EXPOSURE'] },
                { key: 'evaluation.only', value: 7, destinations: ['EVALUATION'] },
              ],
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
  })

  async function startProvider() {
    fetchMock.mockImplementation((url: string) => {
      if (url.toString().includes('exposures')) {
        return Promise.resolve({ ok: true, status: 200 })
      }
      return Promise.resolve(precomputedResponse())
    })
    const provider = new DatadogProvider(baseProviderConfig)
    await OpenFeature.setContext(context)
    await OpenFeature.setProviderAndWait(provider)
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
    await Promise.resolve()
    fetchMock.mockReset()
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('hands each evaluation to the callback with the exposure decision', async () => {
    await startProvider()
    const evaluations: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((evaluation) => evaluations.push(evaluation)))
    const client = OpenFeature.getClient()

    client.getBooleanValue('holdout-flag', true)
    client.getBooleanValue('holdout-flag', true)

    expect(evaluations).toHaveLength(2)
    const [first, second] = evaluations
    expect(first.isExposure()).toBe(true)
    expect(first.isCacheHit()).toBe(false)
    expect(first.shouldSend()).toBe(true)
    expect(second.isExposure()).toBe(true)
    expect(second.isCacheHit()).toBe(true)
    expect(second.shouldSend()).toBe(false)
  })

  it('exposes the evaluation fields and only the HOOK features, frozen', async () => {
    await startProvider()
    const evaluations: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((evaluation) => evaluations.push(evaluation)))
    const client = OpenFeature.getClient()

    client.getBooleanDetails('holdout-flag', true)

    const [evaluation] = evaluations
    expect(evaluation.flagKey).toBe('holdout-flag')
    expect(evaluation.variant).toBe('control')
    expect(evaluation.allocation).toBe('holdout-allocation')
    expect(evaluation.targetingKey).toBe('hook-user')
    expect(evaluation.context).toMatchObject({ targetingKey: 'hook-user' })
    expect(evaluation.details.value).toBe(false)
    expect(evaluation.getFeatures()).toEqual({
      'holdout.key': '06ad',
      'holdout.assignment_group': 'status_quo',
      'holdout.should_include_in_holdout_analysis': false,
    })
    expect(Object.isFrozen(evaluation.getFeatures())).toBe(true)
  })

  it('is not an exposure for errors and allocations that do not log', async () => {
    await startProvider()
    const evaluations: ExposureEvaluation[] = []
    OpenFeature.addHooks(new ExposureHook((evaluation) => evaluations.push(evaluation)))
    const client = OpenFeature.getClient()

    client.getBooleanValue('missing-flag', true)
    client.getBooleanValue('silent-flag', false)

    expect(evaluations).toHaveLength(2)
    expect(evaluations[0].isExposure()).toBe(false)
    expect(evaluations[0].isCacheHit()).toBe(false)
    expect(evaluations[0].shouldSend()).toBe(false)
    expect(evaluations[1].isExposure()).toBe(false)
    expect(evaluations[1].shouldSend()).toBe(false)
  })

  it('keeps the evaluation working when the callback throws, warning once then debugging', async () => {
    await startProvider()
    OpenFeature.addHooks(
      new ExposureHook(() => {
        throw new Error('callback failure')
      })
    )
    const client = OpenFeature.getClient()

    expect(client.getBooleanValue('holdout-flag', true)).toBe(false)
    expect(client.getBooleanValue('holdout-flag', true)).toBe(false)

    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.debug).toHaveBeenCalledTimes(1)
  })

  it('throws without a callback function', () => {
    expect(() => new ExposureHook(undefined as unknown as () => void)).toThrow(TypeError)
  })
})
