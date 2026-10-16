import { getGlobalObject } from '@datadog/browser-core'
import type { FlagEvaluationEvent } from '@datadog/flagging-core'
import { OpenFeature, ProviderStatus } from '@openfeature/web-sdk'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import precomputedResponse from '../data/precomputed-v1.json'
import { createDeferred } from '../transport/fetchTestUtils'

const domain = 'provider-tracking-context'
const options = { clientToken: 'tracking-token', env: 'test', flagEvaluationTrackingInterval: 1000 }
const response = { ok: true, json: async () => precomputedResponse }

describe('online provider tracking context', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  it.each([false, true])(
    'uses the startup context before configuration loads (RUM enabled: %s)',
    async (rumEnabled) => {
      const pending = createDeferred<typeof response>()
      const rumUser = { id: 'startup-rum-user', user_email: 'rum@example.com' }
      const rumEvaluation = jest.fn()
      getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
        getUser: () => rumUser,
        addFeatureFlagEvaluation: rumEvaluation,
      }
      const provider = new DatadogProvider({
        ...options,
        enableRumFeatureFlagTracking: rumEnabled,
        flagConfigurationFetch: jest.fn().mockReturnValue(pending.promise),
      })
      const context = { country: 'US', ...(!rumEnabled && { targetingKey: 'startup-user' }) }
      const ready = OpenFeature.setProviderAndWait(domain, provider, context)
      const client = OpenFeature.getClient(domain)
      const expectedContext = {
        targeting_key: rumEnabled ? 'startup-rum-user' : 'startup-user',
        context: expect.objectContaining({
          evaluation: { country: 'US', ...(rumEnabled && { user_email: 'rum@example.com' }) },
        }),
      }

      try {
        await jest.advanceTimersByTimeAsync(0)
        rumUser.id = 'changed-rum-user'
        expect(client.getBooleanDetails('boolean-flag', false).errorCode).toBe('PROVIDER_NOT_READY')
        jest.advanceTimersByTime(31_000)

        expect(evaluationEvents()).toEqual([
          expect.objectContaining({
            ...expectedContext,
            evaluation_count: 1,
            runtime_default_used: true,
            error: { message: 'PROVIDER_NOT_READY' },
          }),
        ])
        expect(rumEvaluation).not.toHaveBeenCalled()
        expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(0)
      } finally {
        pending.resolve(response)
        await ready
      }

      fetchMock.mockClear()
      expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
      jest.advanceTimersByTime(31_000)
      expect(evaluationEvents()).toEqual([expect.objectContaining({ ...expectedContext, runtime_default_used: false })])
      expect(evaluationEvents()[0].error).toBeUndefined()
    }
  )

  it('keeps the active context during a pending update and switches when the new configuration is accepted', async () => {
    const pending = createDeferred<typeof response>()
    const provider = new DatadogProvider({
      ...options,
      enableRumFeatureFlagTracking: false,
      flagConfigurationFetch: jest.fn().mockResolvedValueOnce(response).mockReturnValue(pending.promise),
    })
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'first-user', country: 'US' })
    const client = OpenFeature.getClient(domain)
    const updating = OpenFeature.setContext(domain, { targetingKey: 'next-user', country: 'CA' })

    try {
      expect(client.providerStatus).toBe(ProviderStatus.RECONCILING)
      expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
      expect(client.getStringDetails('boolean-flag', 'fallback').errorCode).toBe('TYPE_MISMATCH')
      jest.advanceTimersByTime(31_000)

      expect(evaluationEvents()).toHaveLength(2)
      for (const event of evaluationEvents()) {
        expect(event).toMatchObject({ targeting_key: 'first-user', context: { evaluation: { country: 'US' } } })
      }
    } finally {
      pending.resolve(response)
      await updating
    }

    fetchMock.mockClear()
    client.getBooleanValue('boolean-flag', false)
    client.getStringDetails('boolean-flag', 'fallback')
    jest.advanceTimersByTime(31_000)
    expect(evaluationEvents()).toHaveLength(2)
    for (const event of evaluationEvents()) {
      expect(event).toMatchObject({ targeting_key: 'next-user', context: { evaluation: { country: 'CA' } } })
    }
  })

  function evaluationEvents(): FlagEvaluationEvent[] {
    return fetchMock.mock.calls
      .filter(([url]) => url.includes('/flagevaluation'))
      .flatMap(([, request]) =>
        request.body
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line))
      )
  }
})
