import { display, getGlobalObject } from '@datadog/browser-core'
import { ErrorCode, type EvaluationContext, OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import { openDB, STORE_NAME } from '../../src/cache/indexeddb-store'
import { ASSIGNMENT_AUTHORIZATION_FAILED } from '../../src/domain/assignment-token'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { getEvaluationTrackingContext } from '../../src/openfeature/evaluation-telemetry-policy'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import { withRetry } from '../../src/transport/fetch'
import { createFlagsConfigurationFetcher, fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import response from '../data/precomputed-v1.json'

const context = { targetingKey: 'user-a', country: 'US' }
const token = (exp = Date.now() / 1000 + 3600) => `eyJhbGciOiJQUzI1NiJ9.${btoa(JSON.stringify({ exp }))}.signature`
const success = () => new Response(JSON.stringify(response), { status: 200 })
const rejection = () =>
  new Response(
    JSON.stringify({ errors: [{ code: ASSIGNMENT_AUTHORIZATION_FAILED, detail: 'untrusted server text' }] }),
    { status: 401 }
  )
const options: FlaggingInitConfiguration = {
  clientToken: 'client-token',
  env: 'test',
  trackExposures: false,
  enableFlagEvaluationTracking: false,
  enableRumFeatureFlagTracking: false,
}
const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

describe('assignment authorization', () => {
  let fetchMock: jest.Mock
  let provider: DatadogProvider

  beforeEach(() => {
    fetchMock = jest.fn().mockImplementation(success)
    provider = new DatadogProvider({ ...options, flagConfigurationFetch: withRetry(fetchMock, 2) })
    jest.spyOn(display, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    await provider.onClose()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    jest.restoreAllMocks()
  })

  it('extracts the token without mutating the original context or persisting it', async () => {
    const jwt = token()
    const original = Object.freeze({ ...context, dd_assignment_token: jwt })
    const cacheWrite = jest.spyOn(IndexedDBFlagsCache.prototype, 'set')
    await provider.initialize(original)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('DD-Assignment-Token')).toBe(jwt)
    expect(new Headers(init.headers).get('dd-client-token')).toBe('client-token')
    expect(JSON.parse(init.body as string).data.attributes.subject).toEqual({
      targeting_key: 'user-a',
      targeting_attributes: context,
    })
    expect(cacheWrite).toHaveBeenCalledWith(expect.anything(), context, false)
    expect(JSON.stringify(cacheWrite.mock.calls)).not.toContain(jwt)
    expect(JSON.stringify(cacheWrite.mock.calls)).not.toContain('dd_assignment_token')
    expect(original.dd_assignment_token).toBe(jwt)
  })

  it('supports token-only refresh and recovery through OpenFeature without changing cache identity', async () => {
    const stale = jest.fn()
    provider.events.addHandler(ProviderEvents.Stale, stale)
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    const client = OpenFeature.getClient()
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    fetchMock.mockImplementation(rejection)
    await OpenFeature.setContext({ ...context, dd_assignment_token: 'rejected.jwt.signature' })
    // Stale is scheduled after OpenFeature finishes its context reconciliation.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stale).toHaveBeenCalled()
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(display.warn).toHaveBeenCalledWith(`Assignment download failed: ${ASSIGNMENT_AUTHORIZATION_FAILED}`)

    fetchMock.mockImplementation(success)
    const replacement = token(Date.now() / 1000 + 7200)
    await OpenFeature.setContext({ ...context, dd_assignment_token: replacement })
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('DD-Assignment-Token')).toBe(replacement)
  })

  it('emits GENERAL and uses OpenFeature defaults without matching assignments', async () => {
    const error = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, error)
    fetchMock.mockImplementation(rejection)
    await expect(
      OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    ).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: ErrorCode.GENERAL }))
    expect(provider.status).toBe(ProviderStatus.ERROR)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(error.mock.calls)).not.toContain('untrusted server text')
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('untrusted server text')
    fetchMock.mockImplementation(success)
    await OpenFeature.setContext({ ...context, dd_assignment_token: 'replacement.jwt.signature' })
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
  })

  it('recognizes a missing-token rejection from a protected environment', async () => {
    fetchMock.mockImplementation(rejection)
    await expect(provider.initialize(context)).rejects.toMatchObject({
      code: ErrorCode.GENERAL,
      message: ASSIGNMENT_AUTHORIZATION_FAILED,
    })
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(provider.status).toBe(ProviderStatus.ERROR)
  })

  it('does not inherit an assignment token from RUM when it is omitted from OpenFeature context', async () => {
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
      getUser: () => ({ id: 'rum-user', dd_assignment_token: 'rum.jwt.signature', plan: 'premium' }),
      addFeatureFlagEvaluation: jest.fn(),
    }
    provider = new DatadogProvider({
      ...options,
      enableRumFeatureFlagTracking: true,
      flagConfigurationFetch: fetchMock,
    })
    await provider.initialize(context)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('DD-Assignment-Token')).toBe(false)
    const subject = JSON.parse(fetchMock.mock.calls[0][1].body).data.attributes.subject
    expect(subject.targeting_attributes).toEqual({ ...context, plan: 'premium' })
  })

  it('omission removes the token, including on a subject switch', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    await provider.onContextChange({}, { targetingKey: 'user-b' })
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).data.attributes.subject.targeting_key).toBe('user-b')
    await provider.onContextChange({}, context)
    expect(new Headers(fetchMock.mock.calls[2][1].headers).has('DD-Assignment-Token')).toBe(false)
  })

  it('returns defaults after a rejected subject switch instead of evaluating the previous subject', async () => {
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    const client = OpenFeature.getClient()
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    fetchMock.mockImplementation(rejection)
    await OpenFeature.setContext({ targetingKey: 'user-b', dd_assignment_token: token() })
    expect(provider.status).toBe(ProviderStatus.ERROR)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(false)
    // The previous subject's assignments were not evicted: returning to its
    // matching context can still use them after another rejected download.
    await OpenFeature.setContext({ ...context, dd_assignment_token: token() })
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
  })

  it('evaluates portable assignments with the same token-bearing OpenFeature context', async () => {
    const original = Object.freeze({ ...context, dd_assignment_token: token() })
    const core = new DatadogCoreProvider()
    core.setConfiguration(
      await fetchPrecomputedConfiguration({
        clientToken: 'client-token',
        env: 'test',
        context: original,
        fetch: fetchMock,
      })
    )
    await OpenFeature.setProviderAndWait(core, original)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    await OpenFeature.setContext({ ...context, dd_assignment_token: 'replacement.jwt.signature' })
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    expect(original.dd_assignment_token).toBeDefined()
  })

  it('resumes usable assignments immediately when returning to a previously accepted subject', async () => {
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    await OpenFeature.setContext({ targetingKey: 'user-b', dd_assignment_token: token() })
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(false)
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const returning = OpenFeature.setContext({ ...context, dd_assignment_token: token() })
    try {
      expect(provider.status).toBe(ProviderStatus.RECONCILING)
      expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    } finally {
      finish(success())
      await returning
    }
  })

  it('keeps defaults during a retry for a rejected subject with no usable assignments', async () => {
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    const rejected = { targetingKey: 'user-b', dd_assignment_token: token() }
    await OpenFeature.setContext(rejected)
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const retry = OpenFeature.setContext({ ...rejected, dd_assignment_token: 'replacement.jwt.signature' })
    try {
      expect(provider.status).toBe(ProviderStatus.RECONCILING)
      expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(false)
    } finally {
      finish(success())
      await retry
    }
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
  })

  it('does not mask a subsequent invalid opt-out context with a previous authorization failure', async () => {
    provider = new DatadogProvider({
      ...options,
      experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
      flagConfigurationFetch: fetchMock,
    })
    fetchMock.mockImplementation(rejection)
    await expect(provider.initialize({ ...context, dd_assignment_token: token() })).rejects.toThrow(
      ASSIGNMENT_AUTHORIZATION_FAILED
    )
    const invalid = { ...context, dd_experimentation_opt_out_at: 'invalid' }
    await expect(provider.onContextChange({}, invalid)).rejects.toMatchObject({ code: ErrorCode.INVALID_CONTEXT })
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, invalid, logger)).toMatchObject({
      errorCode: ErrorCode.INVALID_CONTEXT,
    })
  })

  it('does not use another subject or attribute set as matching fallback', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    await expect(
      provider.onContextChange({}, { ...context, country: 'CA', dd_assignment_token: token() })
    ).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
    await expect(
      provider.onContextChange({}, { targetingKey: 'user-b', dd_assignment_token: token() })
    ).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
    expect(provider.status).toBe(ProviderStatus.ERROR)
  })

  it('keeps downloaded assignments after expiry and skips clearly expired refreshes', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    await provider.onContextChange({}, { ...context, dd_assignment_token: token(Date.now() / 1000 - 120) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).value).toBe(true)
  })

  it('skips expired downloads without a cache and reports a recoverable GENERAL error', async () => {
    await expect(provider.initialize({ ...context, dd_assignment_token: token(1) })).rejects.toMatchObject({
      code: ErrorCode.GENERAL,
      message: ASSIGNMENT_AUTHORIZATION_FAILED,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    await provider.onContextChange({}, { ...context, dd_assignment_token: token() })
    expect(provider.status).toBe(ProviderStatus.READY)
  })

  it('restores persisted assignments after restart with a different rejected token', async () => {
    const jwt = token()
    // Wait for the actual persistence transaction, not an arbitrary delay.
    const db = await openDB()
    const persisted = new Promise<void>((resolve, reject) => {
      const put = IDBObjectStore.prototype.put
      const spy = jest.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const request = put.apply(this, args)
        if (String(args[1]).startsWith('v2-flags-config-')) {
          spy.mockRestore()
          this.transaction.addEventListener('complete', () => resolve(), { once: true })
          this.transaction.addEventListener('abort', () => reject(this.transaction.error), { once: true })
        }
        return request
      })
    })
    await provider.initialize({ ...context, dd_assignment_token: jwt })
    await persisted
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    expect(records.length).toBeGreaterThan(0)
    expect(JSON.stringify(records)).not.toContain(jwt)
    expect(JSON.stringify(records)).not.toContain('dd_assignment_token')
    await provider.onClose()
    provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
    fetchMock.mockImplementation(rejection)
    await provider.initialize({ ...context, dd_assignment_token: 'replacement.jwt.signature' })
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).value).toBe(true)
  })

  it('binds credentials to request snapshots and ignores late superseded responses', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const first = provider.initialize({ ...context, dd_assignment_token: 'first.jwt.signature' })
    const second = provider.onContextChange({}, { targetingKey: 'user-b', dd_assignment_token: 'second.jwt.signature' })
    await second
    finish(rejection())
    await first
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(display.warn).not.toHaveBeenCalled()
    for (const [index, subject] of ['user-a', 'user-b'].entries()) {
      const init = fetchMock.mock.calls[index][1]
      expect(JSON.parse(init.body).data.attributes.subject.targeting_key).toBe(subject)
      expect(new Headers(init.headers).get('DD-Assignment-Token')).toBe(
        index ? 'second.jwt.signature' : 'first.jwt.signature'
      )
    }
  })

  it('strips tokens from standalone Datadog tracking contexts, including error paths', () => {
    const original = { ...context, dd_assignment_token: token() }
    expect(
      getEvaluationTrackingContext({ value: false, reason: 'ERROR', errorCode: ErrorCode.GENERAL }, () => original)
    ).toEqual(context)
    expect(original).toHaveProperty('dd_assignment_token')
  })

  it('sanitizes standalone assignment fetching and makes the context token authoritative over custom headers', async () => {
    const jwt = token()
    const fetcher = createFlagsConfigurationFetcher({
      ...options,
      customHeaders: { 'dd-assignment-token': 'old-token', 'X-Custom': 'kept' },
      flagConfigurationFetch: fetchMock,
    })
    const config = await fetcher({ ...context, dd_assignment_token: jwt })
    const headers = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(headers.get('DD-Assignment-Token')).toBe(jwt)
    expect(headers.get('X-Custom')).toBe('kept')
    expect(config.precomputed?.context).toEqual(context)
    await fetcher(context)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    await fetchPrecomputedConfiguration({
      clientToken: 'client-token',
      env: 'test',
      context: { ...context, dd_assignment_token: jwt },
      fetch: fetchMock,
    })
    expect(fetchMock.mock.calls[2][1].body).not.toContain(jwt)
  })

  it.each([undefined, 'context.jwt.signature'])(
    'ignores undocumented standalone token options in favor of the context token: %s',
    async (jwt) => {
      const evaluationContext: EvaluationContext = { ...context }
      if (jwt !== undefined) evaluationContext.dd_assignment_token = jwt
      const fetchOptions = {
        clientToken: 'client-token',
        env: 'test',
        context: evaluationContext,
        assignmentToken: 'stray.jwt.signature',
        fetch: fetchMock,
      }
      await fetchPrecomputedConfiguration(fetchOptions)
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(jwt ?? null)
    }
  )

  it.each([42, null, true, {}, '', 'bad\r\nheader'])(
    'rejects unsafe token values locally without echoing them: %p',
    async (value) => {
      await expect(provider.initialize({ ...context, dd_assignment_token: value })).rejects.toThrow(
        ASSIGNMENT_AUTHORIZATION_FAILED
      )
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each(['not-a-jwt', 'header.e30.signature', `header.${btoa('{"exp":"yesterday"}')}.signature`])(
    'leaves malformed JWT strings or missing/invalid expiry to Fastly: %s',
    async (jwt) => {
      await provider.initialize({ ...context, dd_assignment_token: jwt })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('allows the expiry clock-skew window and suppresses expired JWTs at its boundary', async () => {
    const now = Date.now()
    jest.spyOn(Date, 'now').mockReturnValue(now)
    await provider.initialize({ ...context, dd_assignment_token: token(now / 1000 - 59) })
    await provider.onContextChange({}, { ...context, dd_assignment_token: token(now / 1000 - 60) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(provider.status).toBe(ProviderStatus.STALE)
  })

  it.each([401, 500])(
    'does not reflect a credential-bearing HTTP %s error body into OpenFeature errors',
    async (status) => {
      const jwt = token()
      // Use the bare fetch here to avoid transient HTTP retries.
      provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ detail: jwt }] }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )
      await expect(provider.initialize({ ...context, dd_assignment_token: jwt })).rejects.toThrow(`HTTP ${status}`)
    }
  )
})
