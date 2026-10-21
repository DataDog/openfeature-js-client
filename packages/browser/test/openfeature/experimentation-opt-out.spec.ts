import { experimentationOptOutPolicy, type FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { DatadogProvider } from '../../src/openfeature/provider'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import rulesWire from '../data/rules-v1-wire.json'

const context = { targetingKey: 'subject', country: 'US', dd_experimentation_opt_out_at: '2026-10-19T12:00:00Z' }
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const immediate = { experimentationOptOutMode: ExperimentationOptOutMode.Immediate }
const eligible = { targetingKey: 'subject', country: 'US' }
const response = (ack?: unknown) => ({
  data: {
    attributes: {
      createdAt: '2026-10-19T12:00:00Z',
      ...(ack === undefined ? {} : { evaluation_options: { experimentation_opt_out: ack } }),
      flags: Object.fromEntries(
        [
          ['boolean', true],
          ['string', 'ordinary'],
          ['number', 42],
          ['object', { ordinary: true }],
        ].map(([type, value]) => [
          String(type),
          {
            allocationKey: 'ordinary',
            variationKey: 'on',
            variationType: type,
            variationValue: value,
            reason: 'TARGETING_MATCH',
            doLog: false,
          },
        ])
      ),
    },
  },
})
const fetchResponse = (ack?: unknown) => ({ ok: true, json: async () => response(ack) })
const online = (fetch: typeof globalThis.fetch, token = 'test') =>
  new DatadogProvider({
    ...immediate,
    clientToken: token,
    env: 'test',
    flagConfigurationFetch: fetch,
    enableExposureLogging: false,
    enableFlagEvaluationTracking: false,
    enableRumFeatureFlagTracking: false,
  })

describe('immediate experimentation opt-out', () => {
  it('skips local experiment allocations before selecting the ordinary fallback', async () => {
    const options = { experimentationOptOutMode: ExperimentationOptOutMode.Immediate }
    const provider = new DatadogCoreProvider({ ...options, enableEvaluationTelemetryOptOutParameter: false })
    provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    await provider.initialize(context)
    expect(provider.resolveBooleanEvaluation('test-flag', false, context, logger)).toMatchObject({
      value: true,
      flagMetadata: { allocationKey: 'fallback', doLog: false },
    })
  })

  it('sends the effective option to Precompute and rejects a missing acknowledgement', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { createdAt: '2026-10-19T12:00:00Z', flags: {} } } }),
    })
    const options = { experimentationOptOutMode: ExperimentationOptOutMode.Immediate }
    await expect(
      fetchPrecomputedConfiguration({ clientToken: 'test', env: 'test', context, fetch, ...options })
    ).rejects.toThrow('acknowledge')
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.attributes.evaluation_options).toEqual({
      experimentation_opt_out_mode: 'immediate',
    })
  })

  it.each([undefined, ExperimentationOptOutMode.Disabled])('keeps legacy behavior for mode %s', async (mode) => {
    const fetch = jest.fn().mockResolvedValue(fetchResponse())
    await fetchPrecomputedConfiguration({
      clientToken: 'test',
      env: 'test',
      context,
      fetch,
      experimentationOptOutMode: mode,
    })
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.attributes).not.toHaveProperty('evaluation_options')
    const provider = new DatadogCoreProvider({ experimentationOptOutMode: mode })
    provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    await provider.initialize(context)
    expect(provider.resolveBooleanEvaluation('test-flag', false, context, logger).flagMetadata?.doLog).toBe(true)
  })

  it('does not request exclusion when the attribute is absent', async () => {
    const fetch = jest.fn().mockResolvedValue(fetchResponse())
    await fetchPrecomputedConfiguration({ ...immediate, clientToken: 'test', env: 'test', context: eligible, fetch })
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.attributes).not.toHaveProperty('evaluation_options')
  })

  it.each([null, true, false, 42, {}, [], '', 'garbage'])(
    'rejects invalid typed input %j before fetching or evaluation',
    async (value) => {
      const invalid = { ...context, dd_experimentation_opt_out_at: value }
      const fetch = jest.fn().mockResolvedValue(fetchResponse(true))
      const provider = online(fetch)
      await expect(provider.initialize(invalid)).rejects.toThrow('valid timestamp')
      expect(fetch).not.toHaveBeenCalled()
      expect(provider.resolveBooleanEvaluation('boolean', false, invalid, logger)).toMatchObject({
        value: false,
        errorCode: 'INVALID_CONTEXT',
        reason: 'ERROR',
      })
      await provider.onClose()
      const core = new DatadogCoreProvider(immediate)
      core.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
      await expect(core.initialize(invalid)).rejects.toThrow('valid timestamp')
      expect(core.resolveBooleanEvaluation('test-flag', false, invalid, logger).errorCode).toBe('INVALID_CONTEXT')
    }
  )

  it.each([undefined, false, 'true', 1, null])('rejects acknowledgement %j', async (ack) => {
    const fetch = jest.fn().mockResolvedValue(fetchResponse(ack))
    await expect(
      fetchPrecomputedConfiguration({ ...immediate, clientToken: 'test', env: 'test', context, fetch })
    ).rejects.toThrow('acknowledge')
  })

  it('excludes immediately for a future timestamp and serves all value types', async () => {
    const future = { ...context, dd_experimentation_opt_out_at: '2099-01-01T00:00:00Z' }
    const fetch = jest.fn().mockResolvedValue(fetchResponse(true))
    const provider = online(fetch)
    await provider.initialize(future)
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.attributes.evaluation_options).toEqual({
      experimentation_opt_out_mode: 'immediate',
    })
    expect(provider.resolveBooleanEvaluation('boolean', false, future, logger).value).toBe(true)
    expect(provider.resolveStringEvaluation('string', '', future, logger).value).toBe('ordinary')
    expect(provider.resolveNumberEvaluation('number', 0, future, logger).value).toBe(42)
    expect(provider.resolveObjectEvaluation('object', {}, future, logger).value).toEqual({ ordinary: true })
    await provider.onClose()
  })

  it('stops using eligible assignments while the opt-out request is pending or fails', async () => {
    let reject!: (reason: Error) => void
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(fetchResponse())
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          })
      )
    const provider = online(fetch, 'pending')
    await provider.initialize(eligible)
    expect(provider.resolveBooleanEvaluation('boolean', false, eligible, logger).value).toBe(true)
    const update = provider.onContextChange(eligible, context)
    expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(false)
    reject(new Error('offline'))
    await expect(update).rejects.toThrow('offline')
    expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(false)
    await provider.onClose()
  })

  it('does not publish an older subject response after an opted-out update', async () => {
    let resolve!: (value: unknown) => void
    const fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValueOnce(fetchResponse(true))
    const provider = online(fetch, 'late')
    const first = provider.initialize(eligible)
    await provider.onContextChange(eligible, context)
    resolve(fetchResponse())
    await first
    expect(provider.resolveStringEvaluation('string', '', context, logger).value).toBe('ordinary')
    expect(provider.resolveStringEvaluation('string', '', context, logger).flagMetadata?.doLog).toBe(false)
    await provider.onClose()
  })

  it('rejects context-agnostic or unacknowledged portable assignments, then uses rules when available', async () => {
    const config = { precomputed: { response: response(true) } } as FlagsConfiguration
    const core = new DatadogCoreProvider(immediate)
    core.setConfiguration(config)
    await expect(core.initialize(context)).rejects.toThrow('acknowledge')
    expect(core.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(false)
    core.setConfiguration({ ...config, ...configurationFromString(JSON.stringify(rulesWire)) })
    expect(core.resolveBooleanEvaluation('test-flag', false, context, logger).flagMetadata?.allocationKey).toBe(
      'fallback'
    )
  })

  it('separates cached eligible assignments and rechecks acknowledged cache on restart', async () => {
    const cache = new IndexedDBFlagsCache('cache-scope')
    const unacknowledged = { precomputed: { context, response: response() } } as FlagsConfiguration
    cache.set(unacknowledged, context)
    // Reading uses a later transaction on the same database, after the write transaction.
    expect(await cache.get(context, true)).toBeUndefined()
    const config = { precomputed: { context, response: response(true) } } as FlagsConfiguration
    cache.set(config, context, true)
    expect(await cache.get(context, true)).toEqual(config)
    const provider = online(jest.fn().mockRejectedValue(new Error('offline')), 'cache-scope')
    await provider.initialize(context)
    expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(true)
    const other = { ...context, targetingKey: 'other' }
    await expect(provider.onContextChange(context, other)).rejects.toThrow('offline')
    expect(provider.resolveBooleanEvaluation('boolean', false, other, logger).value).toBe(false)
    await provider.onClose()
  })

  it.each(['future', null])('rejects unsupported configuration mode %j at construction', (mode) => {
    expect(() => new DatadogCoreProvider({ experimentationOptOutMode: mode as ExperimentationOptOutMode })).toThrow(
      'disabled, immediate'
    )
  })
})

describe('future experimentation opt-out', () => {
  const future = { experimentationOptOutMode: ExperimentationOptOutMode.FutureExperimentsOnly }
  const preciseContext = { ...context, dd_experimentation_opt_out_at: '2026-10-19T12:00:00.123456789Z' }
  const futureResponse = (cutoff = preciseContext.dd_experimentation_opt_out_at, mode = 'future_experiments_only') => ({
    ...response(),
    data: {
      attributes: {
        ...response().data.attributes,
        evaluation_options: {
          experimentation_opt_out_mode: mode,
          dd_experimentation_opt_out_at: cutoff,
        },
      },
    },
  })
  const options = { ...future, clientToken: 'future', env: 'test', context: preciseContext }

  it.each([
    '2026-10-19T08:00:00.123456789-04:00',
    '2026-10-19T12:00:00.1234567890Z',
    '2026-10-19T12:00:00.1234567899Z',
  ])('accepts equivalent acknowledgement %s and round-trips portable configuration', async (cutoff) => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => futureResponse(cutoff) })
    const configuration = await fetchPrecomputedConfiguration({ ...options, fetch })
    expect(JSON.parse(fetch.mock.calls[0][1].body).data.attributes.evaluation_options).toEqual({
      experimentation_opt_out_mode: 'future_experiments_only',
    })
    const core = new DatadogCoreProvider(future)
    core.setConfiguration(configurationFromString(configurationToString(configuration)))
    await core.initialize(preciseContext)
    expect(core.resolveBooleanEvaluation('boolean', false, preciseContext, logger).value).toBe(true)
    const other = { ...preciseContext, dd_experimentation_opt_out_at: '2026-10-19T12:00:00.123456790Z' }
    expect(core.resolveBooleanEvaluation('boolean', false, other, logger).errorCode).toBe('INVALID_CONTEXT')
  })

  it.each([
    ['2026-10-19T12:00:00.123456788Z', 'future_experiments_only'],
    ['2026-10-19T12:00:00.123456790Z', 'future_experiments_only'],
    [preciseContext.dd_experimentation_opt_out_at, 'immediate'],
    ['', 'future_experiments_only'],
  ])('rejects wrong cutoff %s or mode %s', async (cutoff, mode) => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => futureResponse(cutoff, mode) })
    await expect(fetchPrecomputedConfiguration({ ...options, fetch })).rejects.toThrow('acknowledge')
  })

  it('isolates IndexedDB cache across immediate, future, cutoff, and subject', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => futureResponse() })
    const configuration = await fetchPrecomputedConfiguration({ ...options, fetch })
    const cache = new IndexedDBFlagsCache('future-cache')
    const policy = experimentationOptOutPolicy(preciseContext, 'future_experiments_only')!
    cache.set(configuration, preciseContext, policy)
    expect(await cache.get(preciseContext, policy)).toEqual(configuration)
    expect(await cache.get(preciseContext, true)).toBeUndefined()
    expect(await cache.get(preciseContext, false)).toBeUndefined()
    const offline = jest.fn().mockRejectedValue(new Error('offline'))
    const provider = new DatadogProvider({
      ...future,
      clientToken: 'future-cache',
      env: 'test',
      flagConfigurationFetch: offline,
      enableExposureLogging: false,
      enableFlagEvaluationTracking: false,
      enableRumFeatureFlagTracking: false,
    })
    await provider.initialize(preciseContext)
    expect(provider.resolveBooleanEvaluation('boolean', false, preciseContext, logger).value).toBe(true)
    const changed = { ...preciseContext, dd_experimentation_opt_out_at: '2026-10-19T12:00:00.123456790Z' }
    await expect(provider.onContextChange(preciseContext, changed)).rejects.toThrow('offline')
    expect(provider.resolveBooleanEvaluation('boolean', false, changed, logger).value).toBe(false)
    await provider.onClose()
  })
})
