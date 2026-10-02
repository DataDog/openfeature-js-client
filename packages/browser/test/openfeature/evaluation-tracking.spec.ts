import { getGlobalObject } from '@datadog/browser-core'
import type { FlagEvaluationEvent } from '@datadog/flagging-core'
import { OpenFeature } from '@openfeature/web-sdk'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  composeDatadogTrackingHooks,
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  DatadogProvider,
  type DatadogTrackingHooks,
} from '../../src/rules-based'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const domain = 'evaluation-tracking'
const options = { clientToken: 'tracking-token', env: 'test', flagEvaluationTrackingInterval: 1000 }

describe.each(['core', 'online'] as const)('%s provider evaluation tracking', (kind) => {
  const flagKey = kind === 'core' ? 'test-flag' : 'boolean-flag'
  const variant = kind === 'core' ? 'on' : 'variation-124'
  const rumEvaluation = jest.fn()
  let client: ReturnType<typeof OpenFeature.getClient>
  let tracking: DatadogTrackingHooks | undefined
  let originalFetch: typeof globalThis.fetch
  let fetchMock: jest.Mock

  beforeEach(async () => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = fetchMock
    client = OpenFeature.getClient(domain)
    rumEvaluation.mockReset()
    const rumUser = { id: 'rum-user', user_email: 'rum@example.com' }
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
      addFeatureFlagEvaluation: rumEvaluation,
      getUser: () => rumUser,
    }

    if (kind === 'core') {
      const provider = new DatadogCoreProvider()
      provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
      await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'core-user', country: 'US' })
      tracking = composeDatadogTrackingHooks(
        createDatadogExposureLoggingHook(options),
        createDatadogEvaluationLoggingHook(options),
        createDatadogRumTrackingHook()
      )
      await tracking.initialize()
      client.addHooks(...tracking.hooks)
    } else {
      const provider = new DatadogProvider({
        ...options,
        flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
      })
      await OpenFeature.setProviderAndWait(domain, provider, { country: 'US' })
    }

    // Tracking must use the context of the active configuration, not a fresh RUM lookup.
    rumUser.id = 'changed-rum-user'
  })

  afterEach(async () => {
    client.clearHooks()
    OpenFeature.clearHooks()
    await tracking?.shutdown()
    tracking = undefined
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  it('counts each successful evaluation once', () => {
    expect(client.getBooleanValue(flagKey, false)).toBe(true)
    expect(client.getBooleanValue(flagKey, false)).toBe(true)
    jest.advanceTimersByTime(31_000)

    const events = evaluationEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      flag: { key: flagKey },
      variant: { key: variant },
      evaluation_count: 2,
      runtime_default_used: false,
      ...expectedContext(),
    })
    expect(events[0].error).toBeUndefined()
    expect(rumEvaluation).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(1)
  })

  it.each(['FLAG_NOT_FOUND', 'TYPE_MISMATCH', 'GENERAL'] as const)(
    'tracks %s fallbacks without exposure or RUM events',
    (errorCode) => {
      if (errorCode === 'GENERAL') {
        client.addHooks({
          before: () => {
            throw new Error('before hook failed for private@example.com')
          },
        })
      }
      const evaluatedKey = errorCode === 'FLAG_NOT_FOUND' ? 'missing-flag' : flagKey
      const evaluate = () =>
        errorCode === 'TYPE_MISMATCH'
          ? client.getStringDetails(evaluatedKey, 'fallback')
          : client.getBooleanDetails(evaluatedKey, false)
      const details = evaluate()
      expect(details).toMatchObject({
        value: errorCode === 'TYPE_MISMATCH' ? 'fallback' : false,
        reason: 'ERROR',
        errorCode,
      })
      evaluate()
      jest.advanceTimersByTime(31_000)

      const events = evaluationEvents()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        flag: { key: evaluatedKey },
        evaluation_count: 2,
        runtime_default_used: true,
        error: { message: errorCode },
        ...expectedContext(),
      })
      expect(events[0].variant).toBeUndefined()
      expect(JSON.stringify(events)).not.toContain('private@example.com')
      expect(rumEvaluation).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(0)
    }
  )

  it('keeps successful and failed evaluations of the same flag separate', () => {
    client.getBooleanValue(flagKey, false)
    client.getStringDetails(flagKey, 'fallback')
    jest.advanceTimersByTime(31_000)

    expect(evaluationEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flag: { key: flagKey },
          variant: { key: variant },
          evaluation_count: 1,
          runtime_default_used: false,
        }),
        expect.objectContaining({
          flag: { key: flagKey },
          evaluation_count: 1,
          runtime_default_used: true,
          error: { message: 'TYPE_MISMATCH' },
        }),
      ])
    )
    expect(evaluationEvents()).toHaveLength(2)
  })

  it('does not track a discarded assignment or deduplicate its later successful exposure', () => {
    // Global after hooks run after provider and client after hooks.
    OpenFeature.addHooks({
      after: () => {
        throw new Error('after hook failed')
      },
    })

    expect(client.getBooleanDetails(flagKey, false)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'GENERAL',
    })
    jest.advanceTimersByTime(31_000)

    expect(evaluationEvents()).toEqual([
      expect.objectContaining({
        flag: { key: flagKey },
        evaluation_count: 1,
        runtime_default_used: true,
        error: { message: 'GENERAL' },
      }),
    ])
    expect(rumEvaluation).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(0)

    OpenFeature.clearHooks()
    fetchMock.mockClear()
    expect(client.getBooleanValue(flagKey, false)).toBe(true)
    jest.advanceTimersByTime(31_000)

    expect(rumEvaluation).toHaveBeenCalledWith(flagKey, variant)
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(1)
    expect(evaluationEvents()).toEqual([
      expect.objectContaining({
        flag: { key: flagKey },
        variant: { key: variant },
        evaluation_count: 1,
        runtime_default_used: false,
      }),
    ])
  })

  it('preserves the successful result and other tracking when RUM tracking throws', () => {
    rumEvaluation.mockImplementationOnce(() => {
      throw new Error('RUM unavailable')
    })
    const finallyHook = jest.fn()
    OpenFeature.addHooks({ finally: finallyHook })

    const details = client.getBooleanDetails(flagKey, false)
    expect(details).toMatchObject({ value: true, variant })
    expect(details.errorCode).toBeUndefined()
    expect(finallyHook).toHaveBeenCalledTimes(1)
    expect(finallyHook.mock.calls[0][1]).toBe(details)
    jest.advanceTimersByTime(31_000)

    expect(evaluationEvents()).toEqual([
      expect.objectContaining({
        evaluation_count: 1,
        runtime_default_used: false,
        variant: { key: variant },
      }),
    ])
    expect(evaluationEvents()[0].error).toBeUndefined()
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/exposures'))).toHaveLength(1)
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

  function expectedContext() {
    return {
      targeting_key: kind === 'core' ? 'core-user' : 'rum-user',
      context: {
        evaluation: { country: 'US', ...(kind === 'online' && { user_email: 'rum@example.com' }) },
      },
    }
  }
})
