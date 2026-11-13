import { display, getGlobalObject } from '@datadog/browser-core'
import {
  configurationFromString,
  configurationToString,
  getPrecomputedContext,
  precomputeConfiguration,
} from '@datadog/flagging-core/rules-based'
import { ErrorCode, type EvaluationContext, OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/web-sdk'
import { IndexedDBFlagsCache } from '../../src/cache/indexeddb-flags-cache'
import { openDB, STORE_NAME } from '../../src/cache/indexeddb-store'
import { ASSIGNMENT_AUTHORIZATION_FAILED } from '../../src/domain/assignment-token'
import type { FlaggingInitConfiguration } from '../../src/domain/configuration'
import { DatadogCoreProvider } from '../../src/openfeature/core-provider'
import { DatadogDevtools } from '../../src/openfeature/devtools-provider'
import { getEvaluationTrackingContext } from '../../src/openfeature/evaluation-telemetry-policy'
import { ExperimentationOptOutMode } from '../../src/openfeature/experimentation-opt-out'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import { withRetry } from '../../src/transport/fetch'
import { createFlagsConfigurationFetcher, fetchPrecomputedConfiguration } from '../../src/transport/fetchConfiguration'
import response from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'

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
    expect(cacheWrite).toHaveBeenCalledWith(expect.anything(), context, false, expect.any(AbortSignal))
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
    expect(OpenFeature.getClient().providerStatus).toBe(ProviderStatus.READY)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    await OpenFeature.setContext({ ...context, dd_assignment_token: 'replacement.jwt.signature' })
    expect(OpenFeature.getClient().providerStatus).toBe(ProviderStatus.READY)
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(true)
    expect(original.dd_assignment_token).toBeDefined()
  })

  it.each(['fetching', 'portable'])(
    'loads a server-generated snapshot with a fresh token in the %s provider',
    async (kind) => {
      const original = Object.freeze({ ...context, dd_assignment_token: token() })
      const snapshot = precomputeConfiguration(configurationFromString(JSON.stringify(rulesWire)), original)
      const configuration = configurationFromString(configurationToString(snapshot))
      const browserContext = {
        ...getPrecomputedContext(configuration),
        dd_assignment_token: 'replacement.jwt.signature',
      }
      if (kind === 'fetching') {
        fetchMock.mockImplementation(() => new Response('temporarily unavailable', { status: 503 }))
        provider = new DatadogProvider({
          ...options,
          initialFlagsConfiguration: configuration,
          flagConfigurationFetch: fetchMock,
        })
        await OpenFeature.setProviderAndWait(provider, browserContext)
        expect(provider.status).toBe(ProviderStatus.STALE)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(new Headers(fetchMock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(
          'replacement.jwt.signature'
        )
      } else {
        const core = new DatadogCoreProvider()
        core.setConfiguration(configuration)
        await OpenFeature.setProviderAndWait(core, browserContext)
        expect(OpenFeature.getClient().providerStatus).toBe(ProviderStatus.READY)
        expect(fetchMock).not.toHaveBeenCalled()
      }
      const result = OpenFeature.getClient().getBooleanDetails('test-flag', false)
      expect(result.value).toBe(true)
      expect(result.errorCode).toBeUndefined()
      expect(getPrecomputedContext(configuration)).toEqual(context)
      expect(original.dd_assignment_token).toBeDefined()
    }
  )

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

  it.each([
    ['503', undefined],
    ['503', 'replacement.jwt.signature'],
    ['network error', undefined],
    ['network error', 'replacement.jwt.signature'],
  ])('keeps defaults after a rejected subject retries with %s and token %s', async (failure, replacementToken) => {
    await OpenFeature.setProviderAndWait(provider, { ...context, dd_assignment_token: token() })
    const client = OpenFeature.getClient()
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)

    const rejected = { targetingKey: 'user-b', dd_assignment_token: token() }
    fetchMock.mockImplementation(rejection)
    await OpenFeature.setContext(rejected)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(false)

    fetchMock.mockImplementation(() => {
      if (failure === 'network error') throw new TypeError('Failed to fetch')
      return new Response('temporarily unavailable', { status: 503 })
    })
    await OpenFeature.setContext({
      targetingKey: rejected.targetingKey,
      ...(replacementToken === undefined ? {} : { dd_assignment_token: replacementToken }),
    })
    expect(provider.status).toBe(ProviderStatus.ERROR)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(client.getBooleanDetails('boolean-flag', false)).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: ErrorCode.GENERAL,
    })
    expect(client.getStringValue('string-flag', 'fallback')).toBe('fallback')
    expect(client.getNumberValue('integer-flag', -1)).toBe(-1)
    expect(client.getObjectValue('json-flag', {})).toEqual({})

    fetchMock.mockImplementation(success)
    await OpenFeature.setContext({ ...rejected, dd_assignment_token: 'valid.jwt.signature' })
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
  })

  it.each([ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.FutureExperimentsOnly])(
    'reports GENERAL and tracks the rejected subject in %s mode',
    async (mode) => {
      provider = new DatadogProvider({ ...options, experimentationOptOutMode: mode, flagConfigurationFetch: fetchMock })
      await provider.initialize({ ...context, dd_assignment_token: token() })
      fetchMock.mockImplementation(rejection)
      const rejected = { targetingKey: 'user-b', dd_assignment_token: token() }
      await expect(provider.onContextChange({}, rejected)).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
      const result = provider.resolveBooleanEvaluation('boolean-flag', false, rejected, logger)
      expect(result).toMatchObject({ value: false, reason: 'ERROR', errorCode: ErrorCode.GENERAL })
      expect(getEvaluationTrackingContext(result, () => ({}))).toEqual({ targetingKey: 'user-b' })
    }
  )

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

  it('retains same-subject assignments when a no-token attribute change is rejected', async () => {
    await provider.initialize(context)
    fetchMock.mockImplementation(rejection)
    const changed = { ...context, country: 'CA' }
    await provider.onContextChange({}, changed)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(provider.status).toBe(ProviderStatus.STALE)
    const result = provider.resolveBooleanEvaluation('boolean-flag', false, changed, logger)
    expect(result.value).toBe(true)
    expect(getEvaluationTrackingContext(result, () => ({}))).toEqual(context)
  })

  it('retains the downloaded context for same-subject attribute changes after rejection', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    const changed = { ...context, country: 'CA', dd_assignment_token: token() }
    await provider.onContextChange({}, changed)
    expect(provider.status).toBe(ProviderStatus.STALE)
    const result = provider.resolveBooleanEvaluation('boolean-flag', false, changed, logger)
    expect(result.value).toBe(true)
    expect(getEvaluationTrackingContext(result, () => ({}))).toEqual(context)
    await expect(
      provider.onContextChange({}, { targetingKey: 'user-b', dd_assignment_token: token() })
    ).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
    expect(provider.status).toBe(ProviderStatus.ERROR)
  })

  describe.each([undefined, null, '', 'unsafe token', 'opaque.jwt.token'])('subject switch with token %p', (jwt) => {
    it.each(['503', 'network', 'authorization'])('gates pending and failed assignments for %s', async (failure) => {
      provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
      await provider.initialize(context)
      let finish!: (response: Response) => void
      let fail!: (error: Error) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve, reject) => {
            finish = resolve
            fail = reject
          })
      )
      const requested = { targetingKey: 'user-b', ...(jwt === undefined ? {} : { dd_assignment_token: jwt }) }
      const update = provider.onContextChange({}, requested)
      const completed = expect(update).rejects.toThrow()
      const pending = provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger)
      expect(pending.value).toBe(jwt !== 'opaque.jwt.token')
      expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(
        jwt === 'opaque.jwt.token'
      )
      if (failure === 'network') fail(new TypeError('Failed to fetch'))
      else finish(failure === 'authorization' ? rejection() : new Response('', { status: 503 }))
      await completed
      const protectedRequest = jwt === 'opaque.jwt.token' || failure === 'authorization'
      const result = provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger)
      expect(result.value).toBe(!protectedRequest)
      expect(getEvaluationTrackingContext(result, () => ({}))).toEqual(
        protectedRequest ? { targetingKey: 'user-b' } : context
      )
      if (protectedRequest) {
        fetchMock.mockImplementation(() => new Response('', { status: 503 }))
        await expect(provider.onContextChange({}, { targetingKey: 'user-b' })).rejects.toThrow()
        expect(provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger).value).toBe(false)
      }
    })
  })

  it.each(['503', 'authorization'])(
    'keeps same-subject assignments during attribute refresh and %s failure',
    async (failure) => {
      provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
      await provider.initialize(context)
      const cacheWrite = jest.spyOn(IndexedDBFlagsCache.prototype, 'set')
      let finish!: (response: Response) => void
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          })
      )
      const requested = { ...context, country: 'CA', dd_assignment_token: token() }
      const update = provider.onContextChange({}, requested)
      expect(provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger).value).toBe(true)
      finish(failure === 'authorization' ? rejection() : new Response('', { status: 503 }))
      await update
      expect(provider.status).toBe(ProviderStatus.STALE)
      const result = provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger)
      expect(result.value).toBe(true)
      expect(getEvaluationTrackingContext(result, () => ({}))).toEqual(context)
      expect(cacheWrite).not.toHaveBeenCalled()
      fetchMock.mockImplementation(success)
      await provider.onContextChange({}, requested)
      expect(
        getEvaluationTrackingContext(
          provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger),
          () => ({})
        )
      ).toEqual({ ...context, country: 'CA' })
    }
  )

  it.each(['close', 'reuse', 'devtools'])('preserves the subject boundary across %s', async (lifecycle) => {
    provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
    await OpenFeature.setProviderAndWait(provider, context)
    fetchMock.mockImplementation(rejection)
    await OpenFeature.setContext({ targetingKey: 'user-b', dd_assignment_token: token() })
    fetchMock.mockImplementation(() => new Response('', { status: 503 }))
    if (lifecycle === 'close') await OpenFeature.close()
    else if (lifecycle === 'reuse') {
      await OpenFeature.clearProviders()
      await expect(OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-b' })).rejects.toThrow()
    } else {
      // Replacing the live provider can close/abort the forwarded initialization.
      await OpenFeature.setProviderAndWait(new DatadogDevtools(provider)).catch(() => undefined)
    }
    expect(OpenFeature.getClient().getBooleanValue('boolean-flag', false)).toBe(false)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, { targetingKey: 'user-b' }, logger)).toMatchObject({
      value: false,
      errorCode: ErrorCode.GENERAL,
    })
    fetchMock.mockImplementation(success)
    await provider.initialize({ targetingKey: 'user-b' })
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, { targetingKey: 'user-b' }, logger).value).toBe(
      true
    )
  })

  it.each([ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.FutureExperimentsOnly])(
    'does not relax same-subject context matching in %s mode',
    async (mode) => {
      provider = new DatadogProvider({ ...options, experimentationOptOutMode: mode, flagConfigurationFetch: fetchMock })
      await provider.initialize(context)
      fetchMock.mockImplementation(rejection)
      const changed = { ...context, country: 'CA', dd_assignment_token: token() }
      await expect(provider.onContextChange({}, changed)).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
      expect(provider.resolveBooleanEvaluation('boolean-flag', false, changed, logger).value).toBe(false)
    }
  )

  it('does not let a late no-token response undo an isolated subject switch', async () => {
    provider = new DatadogProvider({ ...options, flagConfigurationFetch: fetchMock })
    await provider.initialize(context)
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const oldUpdate = provider.onContextChange({}, { ...context, country: 'CA' })
    const oldCompletion = expect(oldUpdate).rejects.toThrow()
    fetchMock.mockImplementation(() => new Response('', { status: 503 }))
    const requested = { targetingKey: 'user-b', dd_assignment_token: token() }
    await expect(provider.onContextChange({}, requested)).rejects.toThrow()
    finish(success())
    await oldCompletion
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger).value).toBe(false)
    await provider.onClose()
    await expect(provider.initialize({ targetingKey: 'user-b' })).rejects.toThrow()
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, requested, logger).value).toBe(false)
  })

  it.each([
    ExperimentationOptOutMode.Disabled,
    ExperimentationOptOutMode.Immediate,
    ExperimentationOptOutMode.FutureExperimentsOnly,
  ])('requires a known subject for token-bearing initial snapshot fallback in %s mode', async (mode) => {
    const configuration = await fetchPrecomputedConfiguration({
      clientToken: 'client-token',
      env: 'test',
      context,
      fetch: fetchMock,
    })
    delete configuration.precomputed!.context
    provider = new DatadogProvider({
      ...options,
      experimentationOptOutMode: mode,
      initialFlagsConfiguration: configuration,
      flagConfigurationFetch: fetchMock,
    })
    fetchMock.mockImplementation(() => new Response('', { status: 503 }))
    await expect(provider.initialize({ ...context, dd_assignment_token: token() })).rejects.toThrow('HTTP 503')
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).value).toBe(false)
  })

  it('forwards expired tokens and retains matching assignments after server rejection', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    const expiredToken = token(Date.now() / 1000 - 120)
    await provider.onContextChange({}, { ...context, dd_assignment_token: expiredToken })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('DD-Assignment-Token')).toBe(expiredToken)
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).value).toBe(true)
  })

  it('reports a recoverable GENERAL error when the server rejects an expired token without a cache', async () => {
    const expiredToken = token(1)
    fetchMock.mockImplementation(rejection)
    await expect(provider.initialize({ ...context, dd_assignment_token: expiredToken })).rejects.toMatchObject({
      code: ErrorCode.GENERAL,
      message: ASSIGNMENT_AUTHORIZATION_FAILED,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(expiredToken)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger)).toMatchObject({
      value: false,
      errorCode: ErrorCode.GENERAL,
    })
    fetchMock.mockImplementation(success)
    await provider.onContextChange({}, { ...context, dd_assignment_token: token() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
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

  it.each(['DD-Assignment-Token', 'DD-ASSIGNMENT-TOKEN', 'Dd-Assignment-Token'])(
    'replaces or removes a %s custom header with the context credential',
    async (name) => {
      const jwt = token()
      const fetcher = createFlagsConfigurationFetcher({
        ...options,
        customHeaders: { [name]: 'old-token' },
        flagConfigurationFetch: fetchMock,
      })
      await fetcher({ ...context, dd_assignment_token: jwt })
      const sent = fetchMock.mock.calls[0][1].headers as Record<string, string>
      expect(Object.entries(sent).filter(([header]) => header.toLowerCase() === 'dd-assignment-token')).toEqual([
        ['DD-Assignment-Token', jwt],
      ])
      await fetcher(context)
      expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    }
  )

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

  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    [42, true],
    [true, true],
    [{ secret: 'private.jwt.signature' }, true],
    ['bad\r\nheader', true],
    ['bad\u0000header', true],
    [' ', true],
    ['a b', true],
    ['t\u00f6ken.payload.signature', true],
    ['\ud83d\udd11', true],
  ])('downloads without a token when the replacement is %p (warn: %s)', async (value, warn) => {
    const cacheWrite = jest.spyOn(IndexedDBFlagsCache.prototype, 'set')
    await provider.initialize({ ...context, dd_assignment_token: token() })
    cacheWrite.mockClear()
    const replacement: EvaluationContext = { targetingKey: 'user-b' }
    if (value !== undefined) replacement.dd_assignment_token = value
    await provider.onContextChange({}, replacement)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).data.attributes.subject).toEqual({
      targeting_key: 'user-b',
      targeting_attributes: { targetingKey: 'user-b' },
    })
    expect(cacheWrite).toHaveBeenCalledWith(
      expect.anything(),
      { targetingKey: 'user-b' },
      false,
      expect.any(AbortSignal)
    )
    expect(JSON.stringify(cacheWrite.mock.calls)).not.toContain('dd_assignment_token')
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, replacement, logger).value).toBe(true)
    expect(display.warn).toHaveBeenCalledTimes(warn ? 1 : 0)
    if (warn) {
      expect(display.warn).toHaveBeenCalledWith(
        'Assignment token omitted: expected a string containing only printable ASCII characters without whitespace. Continuing without an assignment token.'
      )
    }
  })

  it.each([null, '', 'bad\r\nheader'])(
    'uses the server rejection for an omitted replacement %p and recovers with a usable token',
    async (value) => {
      await provider.initialize({ ...context, dd_assignment_token: token() })
      fetchMock.mockImplementation(rejection)
      const rejected = { targetingKey: 'user-b', dd_assignment_token: value }
      await expect(provider.onContextChange({}, rejected)).rejects.toThrow(ASSIGNMENT_AUTHORIZATION_FAILED)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
      expect(provider.status).toBe(ProviderStatus.ERROR)
      expect(provider.resolveBooleanEvaluation('boolean-flag', false, rejected, logger)).toMatchObject({
        value: false,
        errorCode: ErrorCode.GENERAL,
      })
      fetchMock.mockImplementation(success)
      const jwt = token()
      await provider.onContextChange({}, { ...rejected, dd_assignment_token: jwt })
      expect(new Headers(fetchMock.mock.calls[2][1].headers).get('DD-Assignment-Token')).toBe(jwt)
      expect(provider.status).toBe(ProviderStatus.READY)
    }
  )

  it('preserves matching assignments when the server rejects a request with an unusable token omitted', async () => {
    await provider.initialize({ ...context, dd_assignment_token: token() })
    fetchMock.mockImplementation(rejection)
    await provider.onContextChange({}, { ...context, dd_assignment_token: 'bad\r\nheader' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(provider.status).toBe(ProviderStatus.STALE)
    expect(provider.resolveBooleanEvaluation('boolean-flag', false, context, logger).value).toBe(true)
  })

  it('removes custom assignment headers when standalone fetching receives an unusable token', async () => {
    const fetcher = createFlagsConfigurationFetcher({
      ...options,
      customHeaders: { 'DD-ASSIGNMENT-TOKEN': 'old.jwt.signature' },
      flagConfigurationFetch: fetchMock,
    })
    const config = await fetcher({ ...context, dd_assignment_token: 'bad\r\nheader' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('DD-Assignment-Token')).toBe(false)
    expect(config.precomputed?.context).toEqual(context)
  })

  it.each(['not-a-jwt', 'header.e30.signature', `header.${btoa('{"exp":"yesterday"}')}.signature`])(
    'leaves malformed JWT strings or missing/invalid expiry to Fastly: %s',
    async (jwt) => {
      await provider.initialize({ ...context, dd_assignment_token: jwt })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([-2, 2])(
    'does not block an assignment request when the device clock is offset by %s hours',
    async (hours) => {
      const jwt = token()
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + hours * 60 * 60 * 1000)
      await provider.initialize({ ...context, dd_assignment_token: jwt })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(jwt)
      expect(provider.status).toBe(ProviderStatus.READY)
      expect(display.warn).not.toHaveBeenCalled()
    }
  )

  it('forwards expired JWTs unchanged when the assignment endpoint accepts them', async () => {
    const payload = btoa(JSON.stringify({ sub: 'x???', exp: Math.floor(Date.now() / 1000) - 120 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const jwt = `eyJhbGciOiJQUzI1NiJ9.${payload}.signature`
    await provider.initialize({ ...context, dd_assignment_token: jwt })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('DD-Assignment-Token')).toBe(jwt)
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(display.warn).not.toHaveBeenCalled()
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
