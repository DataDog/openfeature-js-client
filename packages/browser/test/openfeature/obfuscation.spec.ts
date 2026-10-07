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

  it.each(['online', 'portable'])('keeps %s exposures deduplicated across refreshes and restart', async (kind) => {
    jest.useFakeTimers()
    let payload = response()
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
    const first = client.getBooleanDetails(key, false)
    jest.advanceTimersByTime(31_000)

    // Real edge responses change both the salt and createdAt on each fetch.
    for (const [index, publicSalt] of ['f'.repeat(32), '', salt].entries()) {
      payload = response(publicSalt, true, `2026-09-30T00:0${index + 1}:00Z`)
      await refresh()
      expect(client.getBooleanDetails(key, false).value).toBe(first.value)
      jest.advanceTimersByTime(31_000)
    }
    expect(exposureEvents()).toHaveLength(1)

    // The exposure describes the assigned variant, not its delivered value.
    payload = response(salt, false)
    const assignment = Object.values(payload.data.attributes.flags)[0]
    payload.data.attributes.flags['b'.repeat(64)] = { ...assignment, variationValue: true }
    await refresh()
    expect(client.getBooleanDetails(key, false).value).toBe(false)
    jest.advanceTimersByTime(31_000)
    expect(exposureEvents()).toHaveLength(1)

    for (const [index, change] of [
      { variationKey: 'variant-2' },
      { allocationKey: 'allocation-2' },
      { serialId: 124 },
    ].entries()) {
      Object.assign(assignment, change)
      await refresh()
      client.getBooleanValue(key, true)
      jest.advanceTimersByTime(31_000)
      expect(exposureEvents()).toHaveLength(index + 2)
    }
    expect(exposureEvents()[3]).toMatchObject({
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
    client.getBooleanValue(key, true)
    jest.advanceTimersByTime(31_000)
    expect(exposureEvents()).toHaveLength(4)
    client.clearHooks()
    await tracking?.shutdown()
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
    let resolveRead: ((entries: Record<string, string>) => void) | undefined
    const readStarted = new Promise<void>((started) => {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: {
          storage: {
            local: {
              get: jest.fn(
                () =>
                  new Promise<Record<string, string>>((resolve) => {
                    resolveRead = resolve
                    started()
                  })
              ),
              set: jest.fn().mockResolvedValue(undefined),
              remove: jest.fn().mockResolvedValue(undefined),
            },
          },
        },
      })
    })
    try {
      const provider = new DatadogProvider({ ...options, enableExposureLogging: true })
      let ready = false
      const initialized = OpenFeature.setProviderAndWait(provider, context).then(() => {
        ready = true
      })
      await readStarted
      await jest.advanceTimersByTimeAsync(100)
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('precompute-assignments'))).toBe(true)
      expect(ready).toBe(false)

      resolveRead!({})
      await initialized
      OpenFeature.getClient().getBooleanValue(key, false)
      jest.advanceTimersByTime(31_000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('exposures'))).toHaveLength(1)
    } finally {
      // Let provider shutdown finish if an assertion failed before the read resolved.
      resolveRead?.({})
      Reflect.deleteProperty(globalThis, 'chrome')
    }
  })
})
