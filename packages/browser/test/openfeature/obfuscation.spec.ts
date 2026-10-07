import { createHash } from 'node:crypto'
import { getGlobalObject } from '@datadog/browser-core'
import { OpenFeature, ProviderStatus } from '@openfeature/web-sdk'
import { IndexedDBAssignmentCache } from '../../src/cache/indexeddb-assignment-cache'
import * as indexeddbStore from '../../src/cache/indexeddb-store'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  configurationFromString,
  configurationToString,
  createDatadogExposureLoggingHook,
  DatadogCoreProvider,
} from '../../src/rules-based'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import { deferred } from '../cache/indexeddb-test-helpers'

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

function response(publicSalt: string | undefined = salt, value = true, createdAt = '2026-09-30T00:00:00Z') {
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
        createdAt,
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
    const request = fetchMock.mock.calls[0][1]
    expect(request.headers['X-DD-FEATURE-FLAGS-CAPABILITIES']).toBe('assignment-encoding-flag-key-256-v1')
    expect(JSON.parse(request.body).data.attributes).not.toHaveProperty('supported_capabilities')
    expect(JSON.parse(request.body).data.attributes).toMatchObject({
      source: { sdk_name: 'browser', sdk_version: '1.0.0-test' },
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

  it.each(['', salt])('accepts new flags and future fields on refresh (salt: %s)', async (publicSalt) => {
    const provider = new DatadogProvider(options)
    await provider.initialize(context)
    const payload = response(publicSalt)
    const attributes = payload.data.attributes
    const assignment = Object.values(attributes.flags)[0]
    const lookupKey = (name: string) =>
      publicSalt
        ? createHash('sha256')
            .update('datadog.feature-flags.flag-key.v1\0')
            .update(Buffer.from(publicSalt, 'hex'))
            .update(name)
            .digest('hex')
        : name
    attributes.flags[lookupKey('new-flag')] = { ...assignment, variationValue: false }
    attributes.flags[lookupKey('future-type')] = { ...assignment, variationType: 'future-type' }
    Object.assign(attributes, { futureField: { enabled: true } })
    Object.assign(assignment, { futureAssignmentField: 123 })
    fetchMock.mockResolvedValue(fetchResponse(payload))
    await provider.onContextChange(context, context)

    expect(provider.status).toBe(ProviderStatus.READY)
    expect(provider.resolveBooleanEvaluation(key, false, context, logger).value).toBe(true)
    expect(provider.resolveBooleanEvaluation('new-flag', true, context, logger).value).toBe(false)
    expect(provider.resolveBooleanEvaluation('future-type', false, context, logger)).toMatchObject({
      value: false,
      errorCode: 'PARSE_ERROR',
    })
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

  it.each(['createdAt', 'flags'])('keeps a matching snapshot when plaintext %s is malformed', async (field) => {
    const provider = new DatadogProvider(options)
    fetchMock.mockResolvedValue(fetchResponse(response('')))
    await provider.initialize(context)
    const invalid = response('')
    Object.assign(invalid.data.attributes, { [field]: null })
    fetchMock.mockResolvedValue(fetchResponse(invalid))
    await provider.onContextChange(context, context)
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation(key, false, context, logger).value).toBe(true)
    await provider.onClose()
  })

  it.each(['createdAt', 'flags'])('rejects malformed plaintext %s without a usable cache', async (field) => {
    const invalid = response('')
    Object.assign(invalid.data.attributes, { [field]: null })
    fetchMock.mockResolvedValue(fetchResponse(invalid))
    const provider = new DatadogProvider(options)
    await expect(provider.initialize(context)).rejects.toMatchObject({ code: 'PARSE_ERROR' })
    expect(provider.status).toBe(ProviderStatus.ERROR)
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

  it.each([
    ['online', ''],
    ['online', salt],
    ['portable', ''],
    ['portable', salt],
  ])('preserves %s exposure resets with initial salt "%s"', async (kind, initialSalt) => {
    jest.useFakeTimers()
    let payload = response(initialSalt)
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('precompute-assignments') ? fetchResponse(payload) : { ok: true, status: 200 }
    )
    let tracking: ReturnType<typeof createDatadogExposureLoggingHook> | undefined
    let provider: DatadogProvider | DatadogCoreProvider
    const client = OpenFeature.getClient()
    const install = async () => {
      if (kind === 'online') {
        provider = new DatadogProvider({ ...options, enableExposureLogging: true })
      } else {
        tracking = createDatadogExposureLoggingHook(options)
        await tracking.initialize()
        const core = new DatadogCoreProvider()
        core.setConfiguration(await fetchPrecomputedConfiguration({ ...options, context }))
        provider = core
      }
      await OpenFeature.setProviderAndWait(provider, context)
      if (tracking) client.addHooks(...tracking.hooks)
    }
    const refresh = async () => {
      if (provider instanceof DatadogCoreProvider) {
        const configuration = await fetchPrecomputedConfiguration({ ...options, context })
        provider.setConfiguration(configurationFromString(configurationToString(configuration)))
      } else {
        await provider.onContextChange(context, context)
      }
    }
    const exposureEvents = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes('exposures'))
        .flatMap(([, request]) =>
          (request.body as string)
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        )

    await install()
    const evaluate = () => {
      expect(client.getBooleanValue(key, false)).toBe(true)
      jest.advanceTimersByTime(31_000)
    }
    evaluate()
    evaluate()
    expect(exposureEvents()).toHaveLength(1)

    // createdAt may stay unchanged across requests. Reusing the same snapshot
    // must preserve deduplication, including a portable serialization round trip.
    await refresh()
    evaluate()
    expect(exposureEvents()).toHaveLength(1)

    // Timestamp changes permit another exposure with identical assignment IDs.
    // This also applies to an older timestamp; it is not a monotonic revision.
    for (const [index, createdAt] of ['2026-09-30T00:01:00Z', '2026-09-29T00:00:00Z'].entries()) {
      payload = response(initialSalt, true, createdAt)
      await refresh()
      jest.advanceTimersByTime(31_000)
      expect(exposureEvents()).toHaveLength(index + 1)
      evaluate()
      evaluate()
      expect(exposureEvents()).toHaveLength(index + 2)
    }

    // Cover new salts and both rollout directions without changing assignments.
    for (const [index, publicSalt] of ['f'.repeat(32), '', salt].entries()) {
      payload = response(publicSalt, true, `2026-09-30T00:0${index + 2}:00Z`)
      await refresh()
      evaluate()
      expect(exposureEvents()).toHaveLength(index + 4)
    }

    // Assignment identity changes still produce exposures with a stable timestamp.
    const assignment = Object.values(payload.data.attributes.flags)[0]
    for (const [index, change] of [
      { variationKey: 'variant-2' },
      { allocationKey: 'allocation-2' },
      { serialId: 124 },
    ].entries()) {
      Object.assign(assignment, change)
      await refresh()
      evaluate()
      expect(exposureEvents()).toHaveLength(index + 7)
    }
    expect(exposureEvents()[8]).toMatchObject({
      flag: { key },
      allocation: { key: 'allocation-2' },
      variant: { key: 'variant-2' },
      serial_id: 124,
    })

    // Recreate the provider and hooks without clearing persisted deduplication.
    client.clearHooks()
    await tracking?.shutdown()
    await OpenFeature.clearProviders()
    await install()
    evaluate()
    expect(exposureEvents()).toHaveLength(9)
    client.clearHooks()
    await tracking?.shutdown()
  })

  it.each(['', salt])('preserves first-load behavior with initial salt "%s"', async (publicSalt) => {
    jest.useFakeTimers()
    let payload = response(publicSalt)
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('precompute-assignments') ? fetchResponse(payload) : { ok: true, status: 200 }
    )
    const providerOptions = { ...options, enableExposureLogging: true }
    const exposures = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('exposures'))
    await OpenFeature.setProviderAndWait(new DatadogProvider(providerOptions), context)
    OpenFeature.getClient().getBooleanValue(key, false)
    jest.advanceTimersByTime(31_000)
    expect(exposures()).toHaveLength(1)
    await OpenFeature.clearProviders()

    // Without an initial configuration, first fetch must retain persisted deduplication,
    // even when the server timestamp has changed since the previous page load.
    payload = response(publicSalt, true, '2026-09-30T00:01:00Z')
    await OpenFeature.setProviderAndWait(new DatadogProvider(providerOptions), context)
    OpenFeature.getClient().getBooleanValue(key, false)
    jest.advanceTimersByTime(31_000)
    expect(exposures()).toHaveLength(1)
    await OpenFeature.clearProviders()

    // An explicitly supplied initial configuration restores the normal comparison.
    const initialFlagsConfiguration = await fetchPrecomputedConfiguration({ ...options, context })
    payload = response(publicSalt, true, '2026-09-30T00:02:00Z')
    await OpenFeature.setProviderAndWait(
      new DatadogProvider({ ...providerOptions, initialFlagsConfiguration }),
      context
    )
    jest.advanceTimersByTime(31_000)
    expect(exposures()).toHaveLength(1)
    OpenFeature.getClient().getBooleanValue(key, false)
    jest.advanceTimersByTime(31_000)
    expect(exposures()).toHaveLength(2)
  })

  it.each(['', salt])('keeps configuration usable when clearing exposures fails, salt "%s"', async (publicSalt) => {
    let payload = response(publicSalt)
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('precompute-assignments') ? fetchResponse(payload) : { ok: true, status: 200 }
    )
    const provider = new DatadogProvider({ ...options, enableExposureLogging: true })
    const clear = jest
      .spyOn(IndexedDBAssignmentCache.prototype, 'clear')
      .mockRejectedValue(new Error('storage unavailable'))
    try {
      await provider.initialize(context)
      expect(clear).not.toHaveBeenCalled()
      payload = response(publicSalt, false, '2026-09-30T00:01:00Z')
      await provider.onContextChange(context, context)
      expect(clear).toHaveBeenCalledTimes(1)
      expect(provider.status).toBe(ProviderStatus.READY)
      expect(provider.resolveBooleanEvaluation(key, true, context, logger).value).toBe(false)
    } finally {
      clear.mockRestore()
      await provider.onClose()
    }
  })

  it.each(['', salt])('waits for exposure clearing before publishing configuration, salt "%s"', async (publicSalt) => {
    let payload = response(publicSalt)
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('precompute-assignments') ? fetchResponse(payload) : { ok: true, status: 200 }
    )
    const provider = new DatadogProvider({ ...options, enableExposureLogging: true })
    await provider.initialize(context)
    let finishClear!: () => void
    let startClear!: () => void
    const clearingStarted = new Promise<void>((resolve) => {
      startClear = resolve
    })
    const clearingFinished = new Promise<void>((resolve) => {
      finishClear = resolve
    })
    const clear = jest.spyOn(IndexedDBAssignmentCache.prototype, 'clear').mockImplementation(() => {
      startClear()
      return clearingFinished
    })
    let refreshed = false
    payload = response(publicSalt, false, '2026-09-30T00:01:00Z')
    const refresh = provider.onContextChange(context, context).then(() => {
      refreshed = true
    })
    try {
      await clearingStarted
      // Drain the update chain so an unawaited clear cannot pass this assertion.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(refreshed).toBe(false)
      expect(provider.resolveBooleanEvaluation(key, false, context, logger).value).toBe(true)
      finishClear()
      await refresh
      expect(provider.status).toBe(ProviderStatus.READY)
      expect(provider.resolveBooleanEvaluation(key, true, context, logger).value).toBe(false)
    } finally {
      finishClear()
      await refresh
      clear.mockRestore()
      await provider.onClose()
    }
  })

  it.each(['', salt])('refreshes without an exposure cache when logging is disabled, salt "%s"', async (publicSalt) => {
    fetchMock.mockResolvedValue(fetchResponse(response(publicSalt)))
    const provider = new DatadogProvider(options)
    const clear = jest.spyOn(IndexedDBAssignmentCache.prototype, 'clear')
    try {
      await provider.initialize(context)
      fetchMock.mockResolvedValue(fetchResponse(response(publicSalt, false, '2026-09-30T00:01:00Z')))
      await provider.onContextChange(context, context)
      expect(provider.status).toBe(ProviderStatus.READY)
      expect(provider.resolveBooleanEvaluation(key, true, context, logger).value).toBe(false)
      expect(clear).not.toHaveBeenCalled()
      expect(localStorage.length).toBe(0)
    } finally {
      clear.mockRestore()
      await provider.onClose()
    }
  })

  it('does not serialize assignment values on repeated portable-provider evaluations', async () => {
    const configuration = await fetchPrecomputedConfiguration({ ...options, context })
    const flag = Object.values(configuration.precomputed!.response.data.attributes.flags)[0]
    flag.variationType = 'object'
    flag.variationValue = { large: 'x'.repeat(6600) }
    const provider = new DatadogCoreProvider()
    provider.setConfiguration(configuration)
    await provider.initialize(context)
    const stringify = jest.spyOn(JSON, 'stringify')
    try {
      for (let index = 0; index < 10; index++) {
        const details = provider.resolveObjectEvaluation(key, {}, context, logger)
        expect(details.value).toBe(flag.variationValue)
      }
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('loads persisted exposure identities before reporting ready', async () => {
    jest.useFakeTimers()
    const read = deferred<unknown>()
    const started = deferred<void>()
    const load = jest.spyOn(indexeddbStore, 'withStore').mockImplementationOnce(() => {
      started.resolve()
      return read.promise as Promise<never>
    })
    try {
      const provider = new DatadogProvider({ ...options, enableExposureLogging: true })
      let ready = false
      const initialized = OpenFeature.setProviderAndWait(provider, context).then(() => {
        ready = true
      })
      await started.promise
      await jest.advanceTimersByTimeAsync(100)
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('precompute-assignments'))).toBe(true)
      expect(ready).toBe(false)

      read.resolve([])
      await initialized
      OpenFeature.getClient().getBooleanValue(key, false)
      jest.advanceTimersByTime(31_000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('exposures'))).toHaveLength(1)
    } finally {
      // Let provider shutdown finish if an assertion failed before the read resolved.
      read.resolve([])
      load.mockRestore()
    }
  })
})
