import { createHash } from 'node:crypto'
import {
  evaluate,
  evaluatePrecomputedConfiguration,
  experimentationOptOutPolicy,
  type FlagsConfiguration,
} from '@datadog/flagging-core'
import { configurationFromString, configurationToString } from '@datadog/flagging-core/rules-based'
import { ClientProviderStatus, type EvaluationContext, OpenFeature } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { DatadogProvider } from '../../src/openfeature/provider'
import { fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import rulesWire from '../data/rules-v1-wire.json'
import { createDeferred } from '../transport/fetchTestUtils'

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
  describe.each(['immediate', 'future_experiments_only'] as const)('snapshot filtered by %s', (mode) => {
    const filtered = (boundContext: EvaluationContext = context): FlagsConfiguration => {
      const payload = response(true)
      return {
        precomputed: {
          context: boundContext,
          response: {
            ...payload,
            data: {
              attributes: {
                ...payload.data.attributes,
                evaluation_options: {
                  experimentation_opt_out: true,
                  experimentation_opt_out_mode: mode,
                  dd_experimentation_opt_out_at: context.dd_experimentation_opt_out_at,
                },
              },
            },
          },
        },
      } as FlagsConfiguration
    }

    it.each([
      [ExperimentationOptOutMode.Disabled, context],
      [ExperimentationOptOutMode.Immediate, eligible],
      [ExperimentationOptOutMode.FutureExperimentsOnly, eligible],
    ])('rejects it without effective exclusion: %s, %j', async (policy, subject) => {
      const config = filtered(subject)
      const core = new DatadogCoreProvider({ experimentationOptOutMode: policy })
      core.setConfiguration(config)
      await expect(core.initialize(subject)).rejects.toThrow()
      expect(evaluatePrecomputedConfiguration(config, 'boolean', 'boolean', false, subject, policy).errorCode).toBe(
        'INVALID_CONTEXT'
      )
      expect(evaluate(config, 'boolean', 'boolean', false, subject, logger, policy).errorCode).toBe('INVALID_CONTEXT')
      core.setConfiguration({ ...config, ...configurationFromString(JSON.stringify(rulesWire)) })
      await core.initialize(subject)
      expect(core.resolveBooleanEvaluation('test-flag', false, subject, logger).flagMetadata?.doLog).toBe(true)
    })

    it.each(['initial', 'persistent'] as const)('rejects an offline %s snapshot when disabled', async (source) => {
      const config = filtered()
      const token = `disabled-${mode}-${source}`
      if (source === 'persistent') {
        const cache = new IndexedDBFlagsCache(token)
        cache.set(config, context, false)
        await cache.get(context, false)
      }
      const provider = new DatadogProvider({
        clientToken: token,
        env: 'test',
        initialFlagsConfiguration: source === 'initial' ? config : undefined,
        experimentationOptOutMode: ExperimentationOptOutMode.Disabled,
        flagConfigurationFetch: jest.fn().mockRejectedValue(new Error('offline')),
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      })
      await expect(provider.initialize(context)).rejects.toThrow('offline')
      expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(false)
      await provider.onClose()
    })
  })

  it.each([undefined, context])('preserves unmarked legacy snapshots with context %j', async (boundContext) => {
    const config = { precomputed: { context: boundContext, response: response() } } as FlagsConfiguration
    const core = new DatadogCoreProvider()
    core.setConfiguration(config)
    await core.initialize(context)
    expect(core.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(true)
  })

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

  it.each([null, true, false, 42, {}, [], '', 'garbage', '2026-01-01 00:00:00Z'])(
    'rejects invalid opt-out input %j before fetching or evaluation',
    async (value) => {
      const invalid = { ...context, dd_experimentation_opt_out_at: value }
      const fetch = jest.fn().mockResolvedValue(fetchResponse(true))
      const provider = online(fetch)
      await expect(provider.initialize(invalid)).rejects.toThrow(/dd_experimentation_opt_out_at.*YYYY-MM-DDTHH:mm:ss/)
      expect(fetch).not.toHaveBeenCalled()
      expect(provider.resolveBooleanEvaluation('boolean', false, invalid, logger)).toMatchObject({
        value: false,
        errorCode: 'INVALID_CONTEXT',
        reason: 'ERROR',
      })
      await provider.onClose()
      const core = new DatadogCoreProvider(immediate)
      core.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
      await expect(core.initialize(invalid)).rejects.toThrow(/dd_experimentation_opt_out_at.*YYYY-MM-DDTHH:mm:ss/)
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
    const immediate = experimentationOptOutPolicy(context, 'immediate')!
    expect(await cache.get(context, immediate)).toBeUndefined()
    const config = { precomputed: { context, response: response(true) } } as FlagsConfiguration
    cache.set(config, context, immediate)
    expect(await cache.get(context, immediate)).toEqual(config)
    const provider = online(jest.fn().mockRejectedValue(new Error('offline')), 'cache-scope')
    await provider.initialize(context)
    expect(provider.resolveBooleanEvaluation('boolean', false, context, logger).value).toBe(true)
    const other = { ...context, targetingKey: 'other' }
    await expect(provider.onContextChange(context, other)).rejects.toThrow('offline')
    expect(provider.resolveBooleanEvaluation('boolean', false, other, logger).value).toBe(false)
    await provider.onClose()
  })

  it.each([ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.FutureExperimentsOnly])(
    'keeps configuration parse errors in %s mode',
    (mode) => {
      const provider = new DatadogProvider({
        experimentationOptOutMode: mode,
        clientToken: 'parse-error',
        env: 'test',
        initialFlagsConfiguration: { precomputedError: 'Precomputed configuration flags must be an object' },
        enableExposureLogging: false,
        enableFlagEvaluationTracking: false,
        enableRumFeatureFlagTracking: false,
      })
      expect(provider.resolveBooleanEvaluation('boolean', false, {}, logger)).toMatchObject({
        value: false,
        reason: 'ERROR',
        errorCode: 'PARSE_ERROR',
      })
    }
  )

  it.each(['future', null])('rejects unsupported configuration mode %j at construction', (mode) => {
    expect(() => new DatadogCoreProvider({ experimentationOptOutMode: mode as ExperimentationOptOutMode })).toThrow(
      'disabled, immediate'
    )
  })
})

describe('experimentation opt-out tracking identity', () => {
  const domain = 'experimentation-tracking'
  let originalFetch: typeof globalThis.fetch
  let intake: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    originalFetch = globalThis.fetch
    intake = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = intake
  })
  afterEach(async () => {
    OpenFeature.getClient(domain).clearHooks()
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })
  const events = (channel: string) =>
    intake.mock.calls
      .filter(([url]) => String(url).includes(`/${channel}`))
      .flatMap(([, options]) =>
        String(options.body)
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      )

  const trackingProvider = (fetch: typeof globalThis.fetch, mode = ExperimentationOptOutMode.Immediate) =>
    new DatadogProvider({
      experimentationOptOutMode: mode,
      clientToken: 'tracking-identity',
      env: 'test',
      flagConfigurationFetch: fetch,
      flagEvaluationTrackingInterval: 1000,
      enableEvaluationTelemetryOptOutParameter: true,
      enableExposureLogging: true,
      enableFlagEvaluationTracking: true,
      enableRumFeatureFlagTracking: false,
    })

  it.each(['failed', 'completed'] as const)(
    'uses the requested subject while pending and after a %s refresh',
    async (outcome) => {
      const pending = createDeferred<ReturnType<typeof fetchResponse>>()
      const fetch = jest.fn().mockResolvedValueOnce(fetchResponse()).mockReturnValueOnce(pending.promise)
      const provider = trackingProvider(fetch)
      const a = { targetingKey: 'subject-A' }
      const b = { ...context, targetingKey: 'subject-B' }
      await OpenFeature.setProviderAndWait(domain, provider, a)
      const client = OpenFeature.getClient(domain)
      const update = OpenFeature.setContext(domain, b).catch(() => {})
      expect(client.getBooleanDetails('boolean', false)).toMatchObject({
        value: false,
        errorCode: 'PROVIDER_NOT_READY',
      })
      if (outcome === 'failed') pending.resolve(Promise.reject(new Error('offline')))
      else pending.resolve(fetchResponse(true))
      await update
      expect(client.getBooleanValue('boolean', false)).toBe(outcome === 'completed')
      await provider.onClose()
      const evaluations = events('flagevaluation')
      expect(evaluations.reduce((total, event) => total + event.evaluation_count, 0)).toBe(2)
      expect(
        evaluations.every(
          (event) => event.targeting_key === `sha256_${createHash('sha256').update('subject-B').digest('hex')}`
        )
      ).toBe(true)
    }
  )

  describe.each([ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.FutureExperimentsOnly])(
    'context changes in %s mode',
    (mode) => {
      it.each(['completed', 'failed', 'unacknowledged'] as const)(
        'distinguishes waiting for assignments from malformed input after a %s refresh',
        async (outcome) => {
          const pending = createDeferred<ReturnType<typeof fetchResponse>>()
          const fetch = jest.fn().mockResolvedValueOnce(fetchResponse()).mockReturnValueOnce(pending.promise)
          const provider = trackingProvider(fetch, mode)
          const a = { targetingKey: 'subject-A' }
          const b =
            outcome === 'unacknowledged' ? { ...context, targetingKey: 'subject-B' } : { targetingKey: 'subject-B' }
          await OpenFeature.setProviderAndWait(domain, provider, a)
          const client = OpenFeature.getClient(domain)
          expect(client.getBooleanValue('boolean', false)).toBe(true)
          const update = OpenFeature.setContext(domain, b).catch(() => {})
          expect(client.providerStatus).toBe(ClientProviderStatus.RECONCILING)
          expect(client.getBooleanDetails('boolean', false)).toMatchObject({
            value: false,
            errorCode: 'PROVIDER_NOT_READY',
          })
          if (outcome === 'failed') pending.resolve(Promise.reject(new Error('offline')))
          else pending.resolve(fetchResponse())
          await update
          const result = client.getBooleanDetails('boolean', false)
          expect(result.value).toBe(outcome === 'completed')
          expect(result.errorCode).toBe(outcome === 'completed' ? undefined : 'PROVIDER_NOT_READY')
          const invalid = { ...b, dd_experimentation_opt_out_at: 'not-a-time' }
          await OpenFeature.setContext(domain, invalid)
          expect(client.providerStatus).toBe(ClientProviderStatus.ERROR)
          expect(client.getBooleanDetails('boolean', false)).toMatchObject({
            value: false,
            errorCode: 'INVALID_CONTEXT',
          })
          expect(fetch).toHaveBeenCalledTimes(2)
          await provider.onClose()
        }
      )
    }
  )

  it('keeps the resolved subject when a customer after hook starts another context change', async () => {
    const pending = createDeferred<ReturnType<typeof fetchResponse>>()
    const payload = response()
    payload.data.attributes.flags.boolean.doLog = true
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockReturnValueOnce(pending.promise)
    const provider = trackingProvider(fetch)
    const a = { targetingKey: 'subject-A' }
    await OpenFeature.setProviderAndWait(domain, provider, a)
    const client = OpenFeature.getClient(domain)
    let update: Promise<void> | undefined
    client.addHooks({
      after: () => {
        update = OpenFeature.setContext(domain, { ...context, targetingKey: 'subject-B' })
      },
    })
    expect(client.getBooleanValue('boolean', false)).toBe(true)
    pending.resolve(fetchResponse(true))
    await update
    await provider.onClose()
    expect(events('flagevaluation')).toEqual([
      expect.objectContaining({
        targeting_key: `sha256_${createHash('sha256').update('subject-A').digest('hex')}`,
        evaluation_count: 1,
      }),
    ])
    expect(events('exposures')).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ id: 'subject-A' }) }),
    ])
  })

  it('keeps telemetry opt-out independent while a context update is pending', async () => {
    const pending = createDeferred<ReturnType<typeof fetchResponse>>()
    const fetch = jest.fn().mockResolvedValueOnce(fetchResponse()).mockReturnValueOnce(pending.promise)
    const provider = trackingProvider(fetch)
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'subject-A' })
    const update = OpenFeature.setContext(domain, {
      ...context,
      targetingKey: 'subject-B',
      dd_evaluation_telemetry_opt_out: true,
    })
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean', false)).toBe(false)
    pending.resolve(fetchResponse(true))
    await update
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean', false)).toBe(true)
    await provider.onClose()
    expect(events('flagevaluation')).toEqual([])
  })

  it('preserves active assignment attribution in disabled mode', async () => {
    const pending = createDeferred<ReturnType<typeof fetchResponse>>()
    const fetch = jest.fn().mockResolvedValueOnce(fetchResponse()).mockReturnValueOnce(pending.promise)
    const provider = trackingProvider(fetch, ExperimentationOptOutMode.Disabled)
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'subject-A' })
    const update = OpenFeature.setContext(domain, { ...context, targetingKey: 'subject-B' })
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean', false)).toBe(true)
    pending.resolve(fetchResponse())
    await update
    await provider.onClose()
    expect(events('flagevaluation')).toEqual([
      expect.objectContaining({
        targeting_key: `sha256_${createHash('sha256').update('subject-A').digest('hex')}`,
        evaluation_count: 1,
      }),
    ])
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
    preciseContext.dd_experimentation_opt_out_at,
    '2026-10-19T08:00:00.123456789-04:00',
    '2026-10-19T14:00:00.123456789+02:00',
    '2026-10-19t12:00:00.123456789z',
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

  it.each(['2026-10-19t12:00:00.123456789z', '2026-10-19t08:00:00.123456789999-04:00'])(
    'accepts subject timestamp %s with a normalized server acknowledgement',
    async (timestamp) => {
      const suppliedContext = { ...preciseContext, dd_experimentation_opt_out_at: timestamp }
      const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => futureResponse() })
      const configuration = await fetchPrecomputedConfiguration({ ...options, context: suppliedContext, fetch })
      const core = new DatadogCoreProvider(future)
      core.setConfiguration(configuration)
      await core.initialize(suppliedContext)
      expect(core.resolveBooleanEvaluation('boolean', false, suppliedContext, logger).value).toBe(true)
    }
  )

  it('isolates IndexedDB cache across immediate, future, cutoff, and subject', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => futureResponse() })
    const configuration = await fetchPrecomputedConfiguration({ ...options, fetch })
    const cache = new IndexedDBFlagsCache('future-cache')
    const policy = experimentationOptOutPolicy(preciseContext, 'future_experiments_only')!
    cache.set(configuration, preciseContext, policy)
    expect(await cache.get(preciseContext, policy)).toEqual(configuration)
    expect(await cache.get(preciseContext, experimentationOptOutPolicy(preciseContext, 'immediate')!)).toBeUndefined()
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
