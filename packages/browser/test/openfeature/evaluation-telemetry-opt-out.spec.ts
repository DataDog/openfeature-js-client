import { createHash } from 'node:crypto'
import { getGlobalObject } from '@datadog/browser-core'
import type { FlagEvaluationEvent } from '@datadog/flagging-core'
import {
  type EvaluationContext,
  InMemoryProvider,
  MultiProvider,
  OpenFeature,
  ProviderStatus,
} from '@openfeature/web-sdk'
import { createEvaluationTelemetryPolicy } from '../../src/openfeature/evaluation-telemetry-policy'
import { DatadogProvider } from '../../src/openfeature/provider'
import type { DDRum } from '../../src/openfeature/rumIntegration'
import {
  composeDatadogTrackingHooks,
  configurationFromString,
  createDatadogEvaluationLoggingHook,
  createDatadogExposureLoggingHook,
  createDatadogRumTrackingHook,
  DatadogCoreProvider,
  DatadogDevtools,
  type DatadogTrackingHooks,
} from '../../src/rules-based'
import precomputedResponse from '../data/precomputed-v1.json'
import rulesWire from '../data/rules-v1-wire.json'
import { createDeferred } from '../transport/fetchTestUtils'

const domain = 'evaluation-telemetry-opt-out'
const attribute = 'dd_evaluation_telemetry_opt_out'
const options = { clientToken: 'local-token', env: 'test', flagEvaluationTrackingInterval: 1000 }

describe('evaluation telemetry opt-out', () => {
  let originalFetch: typeof globalThis.fetch
  let uploads: jest.Mock
  let rum: jest.Mock
  let tracking: DatadogTrackingHooks | undefined

  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.clear()
    originalFetch = globalThis.fetch
    uploads = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    globalThis.fetch = uploads
    rum = jest.fn()
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = { addFeatureFlagEvaluation: rum }
  })

  afterEach(async () => {
    OpenFeature.getClient(domain).clearHooks()
    OpenFeature.clearHooks()
    await tracking?.shutdown()
    tracking = undefined
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    delete getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  describe.each(['online', 'rules', 'precomputed'] as const)('%s', (mode) => {
    const flag = mode === 'rules' ? 'test-flag' : 'boolean-flag'
    let coreProvider: DatadogCoreProvider | undefined

    async function initialize(activated: boolean, value: EvaluationContext[string] | undefined) {
      const context = { targetingKey: 'user', country: 'US', ...(value !== undefined && { [attribute]: value }) }
      coreProvider = undefined
      const client = OpenFeature.getClient(domain)
      if (mode === 'online') {
        const provider = new DatadogProvider({
          ...options,
          enableEvaluationTelemetryOptOutParameter: activated,
          flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
        })
        await OpenFeature.setProviderAndWait(domain, provider, context)
      } else {
        const provider = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: activated })
        coreProvider = provider
        provider.setConfiguration(
          mode === 'rules'
            ? configurationFromString(JSON.stringify(rulesWire))
            : configurationFromString(
                JSON.stringify({
                  version: 1,
                  precomputed: {
                    context,
                    response: JSON.stringify(precomputedResponse),
                  },
                })
              )
        )
        await OpenFeature.setProviderAndWait(domain, provider, context)
        tracking = composeDatadogTrackingHooks(
          createDatadogEvaluationLoggingHook(options),
          createDatadogExposureLoggingHook(options),
          createDatadogRumTrackingHook()
        )
        await tracking.initialize()
        client.addHooks(...tracking.hooks)
      }
      return client
    }

    it.each([false, true])('preserves values and exposures with activation=%s', async (activated) => {
      const client = await initialize(activated, true)
      expect(client.getBooleanValue(flag, false)).toBe(true)
      expect(client.getBooleanValue(flag, false)).toBe(true)
      expect(client.getBooleanDetails('missing', false).errorCode).toBe('FLAG_NOT_FOUND')
      expect(client.getStringDetails(flag, 'fallback').errorCode).toBe('TYPE_MISMATCH')
      jest.advanceTimersByTime(31_000)
      expect(evaluationCount()).toBe(activated ? 0 : 4)
      expect(events('exposures')).toHaveLength(1)
      expect(rum).toHaveBeenCalledTimes(activated ? 0 : 2)
    })

    it.each([undefined, false, null, 'true', 1, 0, [true], { enabled: true }])(
      'preserves telemetry for %p',
      async (value) => {
        const client = await initialize(true, value)
        expect(client.getBooleanValue(flag, false)).toBe(true)
        jest.advanceTimersByTime(31_000)
        expect(evaluationCount()).toBe(1)
        expect(events('exposures')).toHaveLength(1)
        expect(rum).toHaveBeenCalledTimes(1)
      }
    )

    it('suppresses error telemetry when a customer before hook throws', async () => {
      const client = await initialize(true, true)
      const customerFinally = jest.fn()
      client.addHooks({
        before: () => {
          throw new Error('customer hook failure')
        },
        finally: customerFinally,
      })
      expect(client.getBooleanDetails(flag, false)).toMatchObject({ value: false, errorCode: 'GENERAL' })
      jest.advanceTimersByTime(31_000)
      expect(evaluationCount()).toBe(0)
      expect(events('exposures')).toHaveLength(0)
      expect(customerFinally).toHaveBeenCalledTimes(1)
    })

    it('keeps queued telemetry and normal exposure deduplication across context updates', async () => {
      const client = await initialize(true, false)
      const update = async (value: boolean) => {
        const context = { targetingKey: 'user', country: 'US', [attribute]: value }
        // Portable precompute callers supply assignments for the complete new context.
        if (mode === 'precomputed') {
          coreProvider!.setConfiguration(
            configurationFromString(
              JSON.stringify({ version: 1, precomputed: { context, response: JSON.stringify(precomputedResponse) } })
            )
          )
        }
        await OpenFeature.setContext(domain, context)
      }
      expect(client.getBooleanValue(flag, false)).toBe(true)
      await update(true)
      expect(client.getBooleanValue(flag, false)).toBe(true)
      await update(false)
      expect(client.getBooleanValue(flag, false)).toBe(true)
      jest.advanceTimersByTime(31_000)
      expect(evaluationCount()).toBe(2)
      expect(events('exposures')).toHaveLength(2)
      expect(rum).toHaveBeenCalledTimes(2)
      // Explicit application instrumentation remains outside this control.
      getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM?.addFeatureFlagEvaluation('manual-flag', 'manual-value')
      expect(rum).toHaveBeenLastCalledWith('manual-flag', 'manual-value')
    })
  })

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('preserves opt-out through MultiProvider with activation=%s, nested=%s', async (activated, nested) => {
    const provider = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: activated })
    provider.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    const inner = new MultiProvider([{ provider }])
    await OpenFeature.setProviderAndWait(domain, nested ? new MultiProvider([{ provider: inner }]) : inner, {
      targetingKey: 'user',
      country: 'US',
      [attribute]: true,
    })
    tracking = composeDatadogTrackingHooks(
      createDatadogEvaluationLoggingHook(options),
      createDatadogExposureLoggingHook(options),
      createDatadogRumTrackingHook()
    )
    await tracking.initialize()
    const client = OpenFeature.getClient(domain)
    client.addHooks(...tracking.hooks)
    expect(client.getBooleanValue('test-flag', false)).toBe(true)
    client.addHooks({
      before: () => {
        throw new Error('Customer hook failure')
      },
    })
    expect(client.getBooleanDetails('test-flag', false)).toMatchObject({ value: false, reason: 'ERROR' })
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(activated ? 0 : 2)
    expect(rum).toHaveBeenCalledTimes(activated ? 0 : 1)
    expect(events('exposures')).toHaveLength(1)
  })

  it.each([false, true])('does not copy unrelated attributes with activation=%s', (activated) => {
    const readUnrelated = jest.fn(() => 'unrelated')
    const context = { targetingKey: 'user', [attribute]: true }
    Object.defineProperty(context, 'unrelated', { enumerable: true, get: readUnrelated })
    const policy = createEvaluationTelemetryPolicy(
      { name: 'test' },
      { enableEvaluationTelemetryOptOutParameter: activated }
    )
    policy.setContext(context)
    expect(policy.allowsTelemetry({})).toBe(!activated)
    expect(readUnrelated).not.toHaveBeenCalled()
  })

  it('uses the selected MultiProvider child policy', async () => {
    const context = { targetingKey: 'user', [attribute]: true }
    const createChild = (flagKey: string, enabled: boolean) => {
      const provider = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: enabled })
      const response = {
        ...precomputedResponse,
        data: {
          ...precomputedResponse.data,
          attributes: {
            ...precomputedResponse.data.attributes,
            flags: { [flagKey]: precomputedResponse.data.attributes.flags['boolean-flag'] },
          },
        },
      }
      provider.setConfiguration(
        configurationFromString(
          JSON.stringify({ version: 1, precomputed: { context, response: JSON.stringify(response) } })
        )
      )
      return provider
    }
    const provider = new MultiProvider([
      { provider: createChild('suppressed', true) },
      { provider: createChild('reported', false) },
    ])
    await OpenFeature.setProviderAndWait(domain, provider, context)
    tracking = composeDatadogTrackingHooks(createDatadogEvaluationLoggingHook(options), createDatadogRumTrackingHook())
    await tracking.initialize()
    const client = OpenFeature.getClient(domain)
    client.addHooks(...tracking.hooks)

    expect(client.getBooleanValue('suppressed', false)).toBe(true)
    expect(client.getBooleanValue('reported', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(1)
    expect(rum).toHaveBeenCalledTimes(1)
    expect(rum).toHaveBeenCalledWith('reported', 'variation-124')
  })

  it.each([false, true])('binds built-in online hooks through MultiProvider with activation=%s', async (activated) => {
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: activated,
      flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
    })
    await OpenFeature.setProviderAndWait(domain, new MultiProvider([{ provider }]), {
      targetingKey: 'user',
      [attribute]: true,
    })
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(activated ? 0 : 1)
    expect(rum).toHaveBeenCalledTimes(activated ? 0 : 1)
    expect(events('exposures')).toHaveLength(1)
  })

  it('does not apply a Datadog child policy to an unrelated provider result', async () => {
    const datadog = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: true })
    datadog.setConfiguration(configurationFromString(JSON.stringify(rulesWire)))
    const fallback = new InMemoryProvider({
      unrelated: { defaultVariant: 'on', variants: { on: true }, disabled: false },
    })
    await OpenFeature.setProviderAndWait(domain, new MultiProvider([{ provider: datadog }, { provider: fallback }]), {
      targetingKey: 'user',
      [attribute]: true,
    })
    tracking = composeDatadogTrackingHooks(createDatadogEvaluationLoggingHook(options), createDatadogRumTrackingHook())
    await tracking.initialize()
    const client = OpenFeature.getClient(domain)
    client.addHooks(...tracking.hooks)

    expect(client.getBooleanDetails('unrelated', false)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'STATIC',
    })
    jest.advanceTimersByTime(31_000)
    expect(rum).toHaveBeenCalledWith('unrelated', 'on')
    expect(evaluationCount()).toBe(1)
  })

  it.each([false, true])('allows rules to target the attribute with activation=%s', async (activated) => {
    const configuration = configurationFromString(JSON.stringify(rulesWire))
    const rules = configuration.rules!.response
    rules.strings = rules.strings.map((value) => (value === 'country' ? attribute : value === 'US' ? 'true' : value))
    rules.regexes = rules.regexes.map((value) => (value === '^US$' ? '^true$' : value))
    const provider = new DatadogCoreProvider({ enableEvaluationTelemetryOptOutParameter: activated })
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'user', [attribute]: true })
    const client = OpenFeature.getClient(domain)
    expect(client.getBooleanDetails('test-flag', false).flagMetadata).toMatchObject({ allocationKey: 'allocation' })
    await OpenFeature.setContext(domain, { targetingKey: 'user', [attribute]: false })
    expect(client.getBooleanDetails('test-flag', false).flagMetadata).toMatchObject({ allocationKey: 'fallback' })
  })

  it('does not restore RUM-derived telemetry admission during an evaluation', async () => {
    let optedOut = true
    getGlobalObject<{ DD_RUM?: DDRum }>().DD_RUM = {
      getUser: () => ({ id: 'user', [attribute]: optedOut }),
      addFeatureFlagEvaluation: rum,
    }
    const fetchAssignments = jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse })
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: true,
      flagConfigurationFetch: fetchAssignments,
    })
    await OpenFeature.setProviderAndWait(domain, provider, {})
    const client = OpenFeature.getClient(domain)
    let update: Promise<void> | undefined
    client.addHooks({
      after: () => {
        optedOut = false
        update = OpenFeature.setContext(domain, {})
      },
    })
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    await update
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(0)
    expect(rum).not.toHaveBeenCalled()
    expect(events('exposures')).toHaveLength(1)
    expect(fetchAssignments).toHaveBeenCalledTimes(2)

    client.clearHooks()
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(1)
    expect(rum).toHaveBeenCalledTimes(1)
  })

  it('refreshes the full context and keeps telemetry suppressed when that refresh fails', async () => {
    const pending = createDeferred<{
      ok: boolean
      statusText?: string
      json: () => Promise<typeof precomputedResponse>
    }>()
    const fetchAssignments = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => precomputedResponse })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: false, statusText: 'offline', json: async () => precomputedResponse })
      .mockResolvedValue({ ok: true, json: async () => precomputedResponse })
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: true,
      flagConfigurationFetch: fetchAssignments,
    })
    const context = { targetingKey: 'user', [attribute]: false }
    await OpenFeature.setProviderAndWait(domain, provider, context)
    const client = OpenFeature.getClient(domain)
    const refresh = OpenFeature.setContext(domain, context)
    const optOut = OpenFeature.setContext(domain, { ...context, [attribute]: true })
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    expect(fetchAssignments).toHaveBeenCalledTimes(3)
    expect(provider.status).toBe(ProviderStatus.RECONCILING)
    pending.resolve({ ok: false, statusText: 'offline', json: async () => precomputedResponse })
    await Promise.all([refresh, optOut])
    expect(provider.status).toBe(ProviderStatus.ERROR)
    // The online provider preserves its previous assignment after transport failure.
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(0)
    expect(events('exposures')).toHaveLength(1)

    await OpenFeature.setContext(domain, context)
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    expect(fetchAssignments).toHaveBeenCalledTimes(4)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(1)
  })

  it.each([
    { activated: true, nextSubject: 'B' },
    { activated: true, nextSubject: 'A' },
    { activated: false, nextSubject: 'B' },
  ])('keeps assignment consent during refresh with %p', async ({ activated, nextSubject }) => {
    const pending = createDeferred<{
      ok: boolean
      statusText?: string
      json: () => Promise<typeof precomputedResponse>
    }>()
    const responseB = JSON.parse(JSON.stringify(precomputedResponse)) as typeof precomputedResponse
    responseB.data.attributes.flags['boolean-flag'].variationValue = false
    responseB.data.attributes.flags['boolean-flag'].variationKey = 'B-variant'
    const fetchAssignments = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => precomputedResponse })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true, json: async () => responseB })
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: activated,
      flagConfigurationFetch: fetchAssignments,
    })
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'A', [attribute]: true })
    const client = OpenFeature.getClient(domain)
    const nextContext = { targetingKey: nextSubject, [attribute]: false }
    const suppressed = activated && nextSubject !== 'A'
    const update = OpenFeature.setContext(domain, nextContext)

    expect(provider.status).toBe(ProviderStatus.RECONCILING)
    expect(client.getBooleanDetails('boolean-flag', false)).toMatchObject({ value: true, variant: 'variation-124' })
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(suppressed ? 0 : 1)
    expect(rum).toHaveBeenCalledTimes(suppressed ? 0 : 1)
    expect(events('exposures')).toHaveLength(1)

    pending.resolve({ ok: false, statusText: 'offline', json: async () => responseB })
    await update
    expect(provider.status).toBe(ProviderStatus.ERROR)
    expect(client.getBooleanDetails('boolean-flag', false)).toMatchObject({ value: true, variant: 'variation-124' })
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(suppressed ? 0 : 2)
    expect(rum).toHaveBeenCalledTimes(suppressed ? 0 : 2)
    expect(events('exposures')).toHaveLength(1)

    await OpenFeature.setContext(domain, nextContext)
    expect(provider.status).toBe(ProviderStatus.READY)
    expect(client.getBooleanDetails('boolean-flag', true)).toMatchObject({ value: false, variant: 'B-variant' })
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(suppressed ? 1 : 3)
    expect(rum).toHaveBeenCalledTimes(suppressed ? 1 : 3)
    expect(evaluations().slice(-1)[0]).toMatchObject({
      targeting_key: `sha256_${createHash('sha256').update(nextSubject).digest('hex')}`,
      context: expect.not.objectContaining({ evaluation: expect.anything() }),
      evaluation_count: 1,
    })
    expect(events('exposures')).toHaveLength(2)
  })

  it('honors A explicit opt-in while B is pending', async () => {
    const pendingA = createDeferred<{ ok: boolean; json: () => Promise<typeof precomputedResponse> }>()
    const pendingB = createDeferred<{ ok: boolean; json: () => Promise<typeof precomputedResponse> }>()
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: true,
      flagConfigurationFetch: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => precomputedResponse })
        .mockReturnValueOnce(pendingA.promise)
        .mockReturnValueOnce(pendingB.promise),
    })
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'A', [attribute]: true })
    const refreshA = OpenFeature.setContext(domain, { targetingKey: 'A', [attribute]: false })
    const refreshB = OpenFeature.setContext(domain, { targetingKey: 'B', [attribute]: false })
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(1)
    expect(rum).toHaveBeenCalledTimes(1)
    expect(events('exposures')).toHaveLength(1)
    pendingA.resolve({ ok: true, json: async () => precomputedResponse })
    pendingB.resolve({ ok: true, json: async () => precomputedResponse })
    await Promise.all([refreshA, refreshB])
  })

  it('keeps policy independent from a late initial response and another provider', async () => {
    const pending = createDeferred<{ ok: true; json: () => Promise<typeof precomputedResponse> }>()
    const fetchAssignments = jest.fn().mockReturnValue(pending.promise)
    const provider = new DatadogProvider({
      ...options,
      enableEvaluationTelemetryOptOutParameter: true,
      flagConfigurationFetch: fetchAssignments,
    })
    const context = { targetingKey: 'user', [attribute]: false }
    const ready = OpenFeature.setProviderAndWait(domain, provider, context)
    await jest.advanceTimersByTimeAsync(0)
    const update = OpenFeature.setContext(domain, { ...context, [attribute]: true })
    const client = OpenFeature.getClient(domain)
    expect(client.getBooleanDetails('boolean-flag', false).errorCode).toBe('PROVIDER_NOT_READY')
    pending.resolve({ ok: true, json: async () => precomputedResponse })
    await Promise.all([ready, update])
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    expect(fetchAssignments).toHaveBeenCalledTimes(2)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(0)

    const other = new DatadogProvider({
      ...options,
      flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
    })
    await OpenFeature.setProviderAndWait('other-opt-out-provider', other, { targetingKey: 'other', [attribute]: true })
    expect(OpenFeature.getClient('other-opt-out-provider').getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(1)
    expect(evaluations()[0].targeting_key).toBe(`sha256_${createHash('sha256').update('other').digest('hex')}`)
  })

  it('preserves opt-out through the Datadog developer-tools wrapper', async () => {
    const provider = new DatadogDevtools(
      new DatadogProvider({
        ...options,
        enableEvaluationTelemetryOptOutParameter: true,
        flagConfigurationFetch: jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse }),
      })
    )
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'user', [attribute]: true })
    expect(OpenFeature.getClient(domain).getBooleanValue('boolean-flag', false)).toBe(true)
    jest.advanceTimersByTime(31_000)
    expect(evaluationCount()).toBe(0)
    expect(events('exposures')).toHaveLength(1)
    expect(rum).not.toHaveBeenCalled()
  })

  it.each([false, true])('counts emissions with activation=%s and boolean true', async (activated) => {
    const fetchAssignments = jest.fn().mockResolvedValue({ ok: true, json: async () => precomputedResponse })
    const configuration = {
      ...options,
      enableEvaluationTelemetryOptOutParameter: activated,
      flagConfigurationFetch: fetchAssignments,
    }
    const provider = new DatadogProvider(configuration)
    await OpenFeature.setProviderAndWait(domain, provider, { targetingKey: 'user', [attribute]: true })
    const client = OpenFeature.getClient(domain)
    const customerHook = jest.fn()
    client.addHooks({ finally: customerHook })

    expect(client.getBooleanDetails('boolean-flag', false)).toMatchObject({
      value: true,
      variant: 'variation-124',
      reason: 'TARGETING_MATCH',
    })
    expect(client.getBooleanValue('boolean-flag', false)).toBe(true)
    expect(client.getBooleanValue('missing-flag', false)).toBe(false)
    expect(client.getStringValue('boolean-flag', 'fallback')).toBe('fallback')
    jest.advanceTimersByTime(31_000)

    expect(evaluations().reduce((count, event) => count + event.evaluation_count, 0)).toBe(activated ? 0 : 4)
    expect(events('exposures')).toHaveLength(1)
    expect(rum).toHaveBeenCalledTimes(activated ? 0 : 2)
    expect(customerHook).toHaveBeenCalledTimes(4)
    expect(fetchAssignments).toHaveBeenCalledTimes(1)
    expect(fetchAssignments.mock.calls[0][1].body.includes(attribute)).toBe(true)
    expect(events('exposures')[0]).toMatchObject({ subject: { attributes: { [attribute]: true } } })
  })

  function events(track: string): Record<string, unknown>[] {
    return uploads.mock.calls
      .filter(([url]) => url.includes(`/${track}`))
      .flatMap(([, request]) =>
        request.body
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line))
      )
  }

  function evaluations(): FlagEvaluationEvent[] {
    return events('flagevaluation') as unknown as FlagEvaluationEvent[]
  }

  function evaluationCount(): number {
    return evaluations().reduce((count, event) => count + event.evaluation_count, 0)
  }
})
