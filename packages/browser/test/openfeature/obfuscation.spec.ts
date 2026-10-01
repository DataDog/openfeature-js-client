import { createHash } from 'node:crypto'
import { getGlobalObject } from '@datadog/browser-core'
import { OpenFeature, ProviderStatus } from '@openfeature/web-sdk'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  configurationFromString,
  configurationToString,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
} from '../../src/rules-based'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'

const context = { targetingKey: 'athlete-123' }
const key = 'new-route-planner'
const salt = '000102030405060708090a0b0c0d0e0f'
const options = {
  clientToken: 'test-token',
  env: 'test',
  enableExposureLogging: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

function response(publicSalt: string | undefined = salt, value = true) {
  const lookupKey = publicSalt
    ? createHash('sha256')
        .update('datadog.feature-flags.flag-key.v1\0')
        .update(Buffer.from(publicSalt, 'hex'))
        .update(key)
        .digest('hex')
    : key
  return {
    data: {
      attributes: {
        createdAt: '2026-09-30T00:00:00Z',
        obfuscated: Boolean(publicSalt),
        obfuscation: publicSalt ? { scheme: 'flag-key-sha256-v1', salt: publicSalt } : undefined,
        flags: {
          [lookupKey]: {
            variationType: 'boolean',
            variationValue: value,
            variationKey: 'variant-1',
            allocationKey: 'allocation-1',
            reason: 'TARGETING_MATCH',
            doLog: true,
            serialId: 123,
          },
        },
      },
    },
  }
}

function fetchResponse(payload: unknown) {
  return { ok: true, headers: new Headers(), json: async () => payload }
}

describe('browser flag-key obfuscation', () => {
  const originalFetch = global.fetch
  let fetchMock: jest.Mock

  beforeEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHooks()
    OpenFeature.clearHandlers()
    localStorage.clear()
    fetchMock = jest.fn().mockResolvedValue(fetchResponse(response()))
    global.fetch = fetchMock
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  it('advertises support and resolves original keys through the online provider', async () => {
    await OpenFeature.setProviderAndWait(new DatadogProvider(options), context)
    const details = OpenFeature.getClient().getBooleanDetails(key, false)
    expect(details).toMatchObject({
      flagKey: key,
      value: true,
      variant: 'variant-1',
      reason: 'TARGETING_MATCH',
      flagMetadata: { allocationKey: 'allocation-1', doLog: true, __dd_split_serial_id: 123 },
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).data.attributes).toMatchObject({
      source: { sdk_name: 'browser', sdk_version: '1.0.0-test' },
      supported_capabilities: { assignment_encodings: ['flag-key-sha256-v1'] },
    })
  })

  it('supports the portable fetch, serialization, and core-provider path', async () => {
    const configuration = await fetchPrecomputedConfiguration({ ...options, context })
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(configurationFromString(configurationToString(configuration)))
    await OpenFeature.setProviderAndWait(provider, context)
    expect(OpenFeature.getClient().getBooleanDetails(key, false)).toMatchObject({ flagKey: key, value: true })
  })

  it('switches between salts and plaintext without changing application calls', async () => {
    const provider = new DatadogProvider(options)
    await provider.initialize(context)
    for (const publicSalt of ['f'.repeat(32), '', salt]) {
      fetchMock.mockResolvedValue(fetchResponse(response(publicSalt)))
      await provider.onContextChange(context, context)
      expect(provider.resolveBooleanEvaluation(key, false, context, logger).value).toBe(true)
    }
    await provider.onClose()
  })

  it('keeps a matching previous snapshot when an encoding is unsupported', async () => {
    const provider = new DatadogProvider(options)
    await provider.initialize(context)
    const invalid = response()
    invalid.data.attributes.obfuscation!.scheme = 'future-encoding'
    fetchMock.mockResolvedValue(fetchResponse(invalid))
    await provider.onContextChange(context, context)
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation(key, false, context, logger).value).toBe(true)
    await expect(provider.onContextChange(context, { targetingKey: 'different-athlete' })).rejects.toThrow(
      'Unsupported precomputed flag-key obfuscation scheme'
    )
    expect(provider.status).toBe(ProviderStatus.ERROR)
    await provider.onClose()
  })

  it('rejects unsupported encoding on a cold start', async () => {
    const invalid = response()
    invalid.data.attributes.obfuscation!.scheme = 'future-encoding'
    fetchMock.mockResolvedValue(fetchResponse(invalid))
    const provider = new DatadogProvider(options)
    await expect(provider.initialize(context)).rejects.toMatchObject({ code: 'PARSE_ERROR' })
    await provider.onClose()
  })

  it('keeps original flag names in exposures, evaluation events, and RUM', async () => {
    jest.useFakeTimers()
    const rum = jest.fn()
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = { addFeatureFlagEvaluation: rum }
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('precompute-assignments') ? fetchResponse(response()) : { ok: true, status: 200 }
    )
    await OpenFeature.setProviderAndWait(
      new DatadogProvider({
        ...options,
        enableExposureLogging: true,
        enableFlagEvaluationTracking: true,
        enableRumFeatureFlagTracking: true,
        flagEvaluationTrackingInterval: 1000,
      }),
      context
    )
    OpenFeature.getClient().getBooleanValue(key, false)
    OpenFeature.getClient().getBooleanValue(key, false)
    jest.advanceTimersByTime(31_000)

    expect(rum).toHaveBeenCalledWith(key, 'variant-1')
    for (const channel of ['exposures', 'flagevaluation']) {
      const requests = fetchMock.mock.calls.filter(([url]) => String(url).includes(channel))
      const events = requests.flatMap(([, request]) =>
        (request.body as string)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      )
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        flag: { key },
        allocation: { key: 'allocation-1' },
        variant: { key: 'variant-1' },
      })
    }
  })

  it('does not repeat portable-provider exposures just because the salt changes', async () => {
    jest.useFakeTimers()
    const tracking = createDatadogExposureLoggingHook(options)
    await tracking.initialize()
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(await fetchPrecomputedConfiguration({ ...options, context }))
    await OpenFeature.setProviderAndWait(provider, context)
    const client = OpenFeature.getClient()
    client.addHooks(...tracking.hooks)
    const first = client.getBooleanDetails(key, false)
    jest.advanceTimersByTime(31_000)

    for (const publicSalt of ['f'.repeat(32), '', salt]) {
      fetchMock.mockResolvedValue(fetchResponse(response(publicSalt)))
      provider.setConfiguration(await fetchPrecomputedConfiguration({ ...options, context }))
      expect(client.getBooleanDetails(key, false)).toEqual(first)
      jest.advanceTimersByTime(31_000)
    }
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('exposures'))).toHaveLength(1)

    // A real assignment change still starts a new exposure identity.
    fetchMock.mockResolvedValue(fetchResponse(response(salt, false)))
    provider.setConfiguration(await fetchPrecomputedConfiguration({ ...options, context }))
    expect(client.getBooleanDetails(key, false).value).toBe(false)
    jest.advanceTimersByTime(31_000)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('exposures'))).toHaveLength(2)
    await tracking.shutdown()
    client.clearHooks()
  })
})
