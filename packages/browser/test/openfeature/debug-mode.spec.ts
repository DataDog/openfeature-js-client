import { configurationFromString } from '@datadog/flagging-core/rules-based'
import { OpenFeature, ProviderStatus } from '@openfeature/web-sdk'
import { withStore } from '../../src/cache/indexeddb-store'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { DatadogDevtools } from '../../src/openfeature/devtools-provider'
import { DatadogProvider } from '../../src/openfeature/provider'
import { withRetry, withTimeout } from '../../src/transport/fetch'
import precomputed from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const options = {
  clientToken: 'transport-secret',
  applicationId: 'app',
  env: 'test',
  debugMode: true,
  trackExposures: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const context = { targetingKey: 'customer@example.com', plan: 'pro', visits: 7, enabled: false }
function response(body: unknown = precomputed, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    statusText: 'Test response',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    clone: () => ({ text: async () => JSON.stringify(body) }),
  } as Response
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

describe('browser debug-mode scenarios', () => {
  let log: jest.SpyInstance
  let fetch: jest.SpyInstance
  const providers: DatadogProvider[] = []
  const events = (event: string) =>
    log.mock.calls
      .map(([line]) => JSON.parse(String(line).slice('[Datadog Feature Flags] '.length)))
      .filter((record) => record.event === event)
  const provider = (extra = {}) => {
    const value = new DatadogProvider({ ...options, ...extra })
    providers.push(value)
    return value
  }
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {})
    fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response())
  })
  afterEach(async () => {
    await OpenFeature.clearProviders()
    await Promise.all(providers.splice(0).map((value) => value.onClose()))
    await withStore('readwrite', (store) => store.count())
    localStorage.clear()
    jest.restoreAllMocks()
  })

  it('logs startup, normalization, install and exact returned values without credentials', async () => {
    const value = provider()
    await value.initialize(context)
    const result = value.resolveStringEvaluation('string-flag', 'red', context, logger)
    expect(result.value).toBe('red')
    expect(events('context.normalized').slice(-1)[0].details).toMatchObject({
      rawContext: context,
      normalizedContext: { visits: '7', enabled: 'false', plan: 'pro' },
    })
    expect(events('configuration.installed').slice(-1)[0].details.source).toBe('network')
    expect(events('evaluation.completed').slice(-1)[0].details).toMatchObject({
      defaultValue: 'red',
      result: { value: 'red', variant: 'variation-123' },
      runtimeDefaultUsed: false,
      valueOrigin: 'assigned_variant',
      effectiveContext: context,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('transport-secret')
  })

  it('prints invalid setup before initialization can run', () => {
    expect(() => provider({ site: 'ddog-gov.com' })).toThrow()
    expect(events('debug.enabled')).toHaveLength(1)
    expect(events('init.failed').slice(-1)[0].details.stage).toBe('endpoint')
  })

  it.each([401, 403, 429, 500])('preserves HTTP %s and the public error outcome', async (status) => {
    fetch.mockResolvedValue(response({ errors: [{ detail: 'backend explanation' }] }, status))
    const value = provider()
    await expect(value.initialize(context)).rejects.toThrow('backend explanation')
    expect(events('fetch.completed').slice(-1)[0].details.httpStatus).toBe(status)
    expect(events('fetch.response_body').slice(-1)[0].details.body).toContain('backend explanation')
    expect(value.status).toBe(ProviderStatus.ERROR)
  })

  it('does not invent a cause for ambiguous browser network failures', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(provider().initialize(context)).rejects.toThrow()
    expect(events('fetch.failed').slice(-1)[0].details).toMatchObject({ cause: 'unknown_transport_failure' })
  })

  it('distinguishes pre-ready, missing flags and type mismatches from assignments', async () => {
    const value = provider()
    value.resolveBooleanEvaluation('boolean-flag', false, context, logger)
    expect(events('evaluation.completed').slice(-1)[0].details.result.errorCode).toBe('PROVIDER_NOT_READY')
    await value.initialize(context)
    value.resolveStringEvaluation('missing', 'default', context, logger)
    expect(events('evaluation.completed').slice(-1)[0].details.result.errorCode).toBe('FLAG_NOT_FOUND')
    value.resolveStringEvaluation('boolean-flag', 'default', context, logger)
    expect(events('evaluation.completed').slice(-1)[0].details.result.errorCode).toBe('TYPE_MISMATCH')
  })

  it('shows a same-context cache recovery and refuses a different-context fallback', async () => {
    const value = provider()
    await value.initialize(context)
    fetch.mockRejectedValue(new TypeError('offline'))
    await value.onContextChange(context, context)
    expect(value.status).toBe(ProviderStatus.STALE)
    expect(events('cache.fallback').slice(-1)[0].details).toMatchObject({ source: 'memory', requestedContext: context })
    await expect(value.onContextChange(context, { targetingKey: 'another-user' })).rejects.toThrow('offline')
    expect(events('cache.eligibility').slice(-1)[0].details.eligible).toBe(false)
  })

  it('logs malformed and partially rejected responses separately', async () => {
    const value = provider()
    fetch.mockResolvedValue(response({ unexpected: true }))
    await expect(value.initialize(context)).rejects.toThrow()
    expect(events('configuration.decoded').slice(-1)[0].details.outcome).toBe('rejected')
    const partial = JSON.parse(JSON.stringify(precomputed))
    partial.data.attributes.flags.broken = { variationType: 'UNKNOWN' }
    fetch.mockResolvedValue(response(partial))
    await value.onContextChange(context, context)
    expect(events('configuration.decoded').slice(-1)[0].details).toMatchObject({
      receivedCount: Object.keys(partial.data.attributes.flags).length,
      acceptedCount: Object.keys(partial.data.attributes.flags).length - 1,
      rejectedCount: 1,
      rejectedKeys: ['broken'],
      rejectionScope: 'individual_flags',
    })
    expect(events('configuration.decoded').slice(-1)[0].details.flagErrors.broken).toBeTruthy()
    expect(value.resolveStringEvaluation('string-flag', 'default', context, logger).value).toBe('red')
  })

  it('correlates superseded responses and preserves the newest context', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const value = provider()
    const init = value.initialize(context)
    const nextContext = { targetingKey: 'new-user' }
    const change = value.onContextChange(context, nextContext)
    second.resolve(response())
    await change
    first.resolve(response())
    await init
    expect(events('fetch.cancelled').length).toBeGreaterThan(0)
    expect(events('configuration.discarded').slice(-1)[0].details.reason).toBe('superseded')
    value.resolveStringEvaluation('string-flag', 'default', nextContext, logger)
    expect(events('evaluation.completed').slice(-1)[0].details.effectiveContext).toEqual(nextContext)
  })

  it('logs shutdown cancellation and rejects installation after close', async () => {
    const pending = deferred<Response>()
    fetch.mockReturnValue(pending.promise)
    const value = provider()
    const init = value.initialize(context)
    await value.onClose()
    pending.resolve(response())
    await init
    expect(value.status).toBe(ProviderStatus.NOT_READY)
    expect(events('configuration.discarded').slice(-1)[0].details.reason).toBe('closed')
  })

  it('logs retry policy/attempts and keeps the configured retry outcome', async () => {
    fetch.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response())
    const value = provider({ flagConfigurationFetch: withRetry(globalThis.fetch, 1) })
    await value.initialize(context)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(events('fetch.retry_scheduled')).toHaveLength(1)
    expect(events('fetch.attempt').map((record) => record.details.attempt)).toEqual([1, 2])
  })

  it('logs a real request timeout without treating it as a provider wait deadline', async () => {
    const transport: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    await expect(
      provider({ flagConfigurationFetch: withTimeout(transport, 5) }).initialize(context)
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(events('fetch.timeout').slice(-1)[0].details.timeoutMs).toBe(5)
  })

  it('keeps evaluation and initialization identical with a throwing console', async () => {
    const value = provider()
    log.mockImplementation(() => {
      throw new Error('console failed')
    })
    await value.initialize(context)
    expect(value.resolveStringEvaluation('string-flag', 'default', context, logger).value).toBe('red')
  })

  it('leaves debug disabled silent through success, default and shutdown', async () => {
    const value = provider({ debugMode: false })
    await value.initialize(context)
    value.resolveStringEvaluation('missing', 'default', context, logger)
    await value.onClose()
    expect(log).not.toHaveBeenCalled()
  })

  it('explains RUM enrichment and exposure deduplication at the OpenFeature boundary', async () => {
    const rum = {
      getUser: () => ({ id: 'rum-user', plan: 'rum-plan', nested: { ignored: true } }),
      addFeatureFlagEvaluation: jest.fn(),
    }
    const scope = globalThis as typeof globalThis & { DD_RUM?: typeof rum }
    scope.DD_RUM = rum
    try {
      const value = provider({ enableRumFeatureFlagTracking: true, enableFlagEvaluationTracking: true })
      await OpenFeature.setProviderAndWait('debug-tracking', value, context)
      const client = OpenFeature.getClient('debug-tracking')
      client.getStringValue('string-flag', 'default')
      client.getStringValue('string-flag', 'default')
      expect(events('context.rum_enrichment').slice(-1)[0].details).toMatchObject({
        precedence: 'application',
        user: { id: 'rum-user' },
      })
      expect(events('exposure.decision').map((record) => record.details.outcome)).toEqual(['record_only', 'duplicate'])
      expect(events('evaluation.aggregated')).toHaveLength(2)
      expect(events('evaluation.returned')).toHaveLength(2)
      expect(rum.addFeatureFlagEvaluation).toHaveBeenCalledWith('string-flag', 'variation-123')
      expect(events('rum.annotation').slice(-1)[0].details.outcome).toBe('handed_to_rum')
    } finally {
      delete scope.DD_RUM
    }
  })

  it('explains evaluation/RUM opt-out without suppressing exposure recording', async () => {
    const value = provider({
      enableEvaluationTelemetryOptOutParameter: true,
      enableFlagEvaluationTracking: true,
      enableRumFeatureFlagTracking: true,
    })
    await OpenFeature.setProviderAndWait('debug-opt-out', value, { ...context, dd_evaluation_telemetry_opt_out: true })
    OpenFeature.getClient('debug-opt-out').getStringValue('string-flag', 'default')
    expect(events('tracking.policy').some((record) => record.details.allowed === false)).toBe(true)
    expect(events('evaluation.aggregated')).toHaveLength(0)
    expect(events('exposure.decision').slice(-1)[0].details.outcome).toBe('record_only')
  })

  it('keeps fresh assignments usable when IndexedDB fails', async () => {
    const open = jest.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new DOMException('storage denied', 'SecurityError')
    })
    try {
      const value = provider()
      await value.initialize(context)
      expect(value.resolveStringEvaluation('string-flag', 'default', context, logger).value).toBe('red')
      expect(events('cache.read_failed').length).toBeGreaterThan(0)
      expect(events('exposure.persistence_failed').length).toBeGreaterThan(0)
      expect(events('cache.write_failed').length).toBeGreaterThan(0)
    } finally {
      open.mockRestore()
    }
  })

  it('records failed persistence without treating it as a failed fetch', async () => {
    const put = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      const value = provider()
      await value.initialize(context)
      await withStore('readwrite', (store) => store.count())
      expect(value.status).toBe(ProviderStatus.READY)
      expect(events('cache.write_failed').slice(-1)[0].details.action).toBe('retain_memory')
    } finally {
      put.mockRestore()
    }
  })

  it('logs dropped selection and unsupported response capabilities', async () => {
    const value = provider({ flagSelection: { tags: Array.from({ length: 40 }, (_, index) => 'tag-' + index) } })
    expect(events('configuration.selection')[0].details.error).toBe('too_many_values')
    const encoded = JSON.parse(JSON.stringify(precomputed))
    encoded.data.attributes.obfuscated = true
    encoded.data.attributes.obfuscation = { scheme: 'future-scheme', salt: 'salt' }
    fetch.mockResolvedValue(response(encoded))
    await expect(value.initialize(context)).rejects.toThrow()
    expect(events('configuration.decoded').slice(-1)[0].details.outcome).toBe('rejected')
  })

  it('explains local rules and a devtools override', async () => {
    const value = new DatadogCoreProvider({ debugMode: true })
    value.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    await value.initialize({ targetingKey: 'user-1', country: 'US' })
    expect(
      value.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'user-1', country: 'US' }, logger).value
    ).toBe(true)
    expect(events('evaluation.trace').length).toBeGreaterThan(0)
    localStorage.setItem('dd.dd_flag.overrides', JSON.stringify({ 'test-flag': { type: 'BOOLEAN', value: false } }))
    const wrapper = new DatadogDevtools(value)
    await wrapper.initialize({ targetingKey: 'user-1', country: 'US' })
    expect(wrapper.resolveBooleanEvaluation('test-flag', true, context, logger).value).toBe(false)
    expect(events('evaluation.completed').slice(-1)[0].details).toMatchObject({
      valueOrigin: 'local_override',
      value: false,
      runtimeDefaultUsed: false,
    })
    await wrapper.onClose()
  })
})
