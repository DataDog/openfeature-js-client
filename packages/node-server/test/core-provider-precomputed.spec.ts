import { createHash } from 'node:crypto'
import type { Channel } from 'node:diagnostics_channel'
import type { ExposureEvent, FlagsConfiguration } from '@datadog/flagging-core'
import { type EvaluationContext, OpenFeature, ProviderEvents, ServerProviderStatus } from '@openfeature/server-sdk'
import rulesWire from '../../browser/test/data/rules-v1-wire.json'
import {
  configurationFromString,
  configurationToString,
  DatadogCoreProvider,
  ExperimentationOptOutMode,
  fetchRulesConfiguration,
  precomputeConfiguration,
} from '../src/rules-based'

const context = { targetingKey: 'user-1', country: 'US' }

function rules(): FlagsConfiguration {
  return configurationFromString(JSON.stringify(rulesWire))
}

function precomputed(): FlagsConfiguration {
  return precomputeConfiguration(rules(), context)
}

function clientFor(provider: DatadogCoreProvider) {
  OpenFeature.setProvider(provider)
  return OpenFeature.getClient()
}

function encodeFlagKeys(configuration: FlagsConfiguration): FlagsConfiguration {
  const attributes = configuration.precomputed!.response.data.attributes
  const salt = '00112233445566778899aabbccddeeff'
  attributes.obfuscated = true
  attributes.obfuscation = { scheme: 'flag-key-sha256-v1', salt }
  attributes.flags = Object.fromEntries(
    Object.entries(attributes.flags).map(([key, assignment]) => [
      createHash('sha256')
        .update('datadog.feature-flags.flag-key.v1\0')
        .update(Buffer.from(salt, 'hex'))
        .update(key)
        .digest('hex'),
      assignment,
    ])
  )
  return configuration
}

describe('DatadogCoreProvider precomputed configuration', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    OpenFeature.setLogger({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() })
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    OpenFeature.clearHooks()
    OpenFeature.clearHandlers()
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('fetches server rules, precomputes locally, and evaluates the serialized snapshot without another request', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      expect(new URL(String(url)).pathname).toBe('/api/v2/feature-flagging/config/rules-based/server')
      expect(options?.headers).toMatchObject({ 'dd-api-key': 'test-key' })
      return new Response(Buffer.from(rulesWire.rules.response, 'base64'), {
        headers: { 'Content-Type': 'application/protobuf' },
      })
    })
    const configuration = await fetchRulesConfiguration({
      distributionChannel: 'server',
      apiKey: 'test-key',
      env: 'prod',
    })
    const wire = configurationToString(precomputeConfiguration(configuration, context))
    fetch.mockRejectedValue(new Error('No further network access'))
    const provider = new DatadogCoreProvider(configurationFromString(wire))
    const client = clientFor(provider)

    expect(provider.getConfiguration().rules).toBeUndefined()
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      flagMetadata: { __dd_allocation_key: 'allocation', __dd_split_serial_id: 7, __dd_do_log: true },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each<EvaluationContext>([
    { ...context, targetingKey: 'another-user' },
    { ...context, country: 'CA' },
    { ...context, extra: true },
    { country: 'US' },
    {},
  ])('does not reuse a context-bound assignment for %j', async (otherContext) => {
    const client = clientFor(new DatadogCoreProvider(precomputed()))
    await expect(client.getBooleanDetails('test-flag', false, otherContext)).resolves.toMatchObject({
      value: false,
      errorCode: 'INVALID_CONTEXT',
    })
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
  })

  it('retains the shared format semantics for explicitly context-agnostic snapshots', async () => {
    const configuration = precomputed()
    delete configuration.precomputed!.context
    const client = clientFor(new DatadogCoreProvider(configuration))
    await expect(client.getBooleanValue('test-flag', false, {})).resolves.toBe(true)
    await expect(client.getBooleanValue('test-flag', false, { targetingKey: 'another-user' })).resolves.toBe(true)
  })

  it.each([false, true])('reads all value types with encoded keys=%s and detaches object values', async (encoded) => {
    const configuration = precomputed()
    const flags = configuration.precomputed!.response.data.attributes.flags
    const assignment = flags['test-flag']
    flags.string = { ...assignment, variationType: 'string', variationValue: 'hello' }
    flags.number = { ...assignment, variationType: 'number', variationValue: 12.5 }
    flags.object = { ...assignment, variationType: 'object', variationValue: { nested: { enabled: true } } }
    const parsed = configurationFromString(
      configurationToString(encoded ? encodeFlagKeys(configuration) : configuration)
    )
    const client = clientFor(new DatadogCoreProvider(parsed))

    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    await expect(client.getStringValue('string', 'default', context)).resolves.toBe('hello')
    await expect(client.getNumberValue('number', 0, context)).resolves.toBe(12.5)
    const value = await client.getObjectValue<{ nested: { enabled: boolean } }>(
      'object',
      { nested: { enabled: false } },
      context
    )
    value.nested.enabled = false
    await expect(client.getObjectValue('object', {}, context)).resolves.toEqual({ nested: { enabled: true } })
    await expect(client.getStringDetails('test-flag', 'fallback', context)).resolves.toMatchObject({
      errorCode: 'TYPE_MISMATCH',
    })
    await expect(client.getBooleanDetails('missing', false, context)).resolves.toMatchObject({
      errorCode: 'FLAG_NOT_FOUND',
    })
  })

  it('replaces rules with precomputed assignments and back, without exposing mutable snapshots', async () => {
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    const changed = jest.fn()
    client.addHandler(ProviderEvents.ConfigurationChanged, changed)
    const input = precomputed()
    input.precomputed!.response.data.attributes.flags['test-flag'].variationValue = false
    provider.setConfiguration(input)
    input.precomputed!.response.data.attributes.flags = {}
    const copy = provider.getConfiguration()
    copy.precomputed!.context!.targetingKey = 'another-user'
    copy.precomputed!.response.data.attributes.flags = {}
    await expect(client.getBooleanValue('test-flag', true, context)).resolves.toBe(false)

    provider.setConfiguration(precomputeConfiguration(rules(), { ...context, country: 'CA' }))
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      errorCode: 'INVALID_CONTEXT',
    })
    await expect(client.getBooleanValue('test-flag', false, { ...context, country: 'CA' })).resolves.toBe(true)
    provider.setConfiguration(rules())
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it.each([
    { precomputed: { response: {} } },
    { precomputed: { response: { data: { attributes: { createdAt: 'now', flags: [] } } } } },
    { precomputed: { response: { data: { attributes: { createdAt: 'now', flags: {}, obfuscated: true } } } } },
  ])('rejects malformed precomputed input and retains the active snapshot: %j', async (invalid) => {
    expect(() => new DatadogCoreProvider(invalid as FlagsConfiguration)).toThrow(TypeError)
    const provider = new DatadogCoreProvider(precomputed())
    const client = clientFor(provider)
    const changed = jest.fn()
    client.addHandler(ProviderEvents.ConfigurationChanged, changed)
    expect(() => provider.setConfiguration(invalid as FlagsConfiguration)).toThrow(TypeError)
    expect(changed).not.toHaveBeenCalled()
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
  })

  it('accepts an empty snapshot and isolates malformed flags from valid assignments', async () => {
    const configuration = precomputed()
    configuration.precomputed!.response.data.attributes.flags.bad = {} as never
    const provider = new DatadogCoreProvider(configuration)
    const client = clientFor(provider)
    await expect(client.getBooleanDetails('bad', false, context)).resolves.toMatchObject({ errorCode: 'PARSE_ERROR' })
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    configuration.precomputed!.response.data.attributes.flags = {}
    provider.setConfiguration(configuration)
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      errorCode: 'FLAG_NOT_FOUND',
    })
  })

  it.each([
    [ExperimentationOptOutMode.Disabled, ExperimentationOptOutMode.Disabled, false],
    [ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.Immediate, false],
    [ExperimentationOptOutMode.Disabled, ExperimentationOptOutMode.Immediate, true],
    [ExperimentationOptOutMode.Immediate, ExperimentationOptOutMode.Disabled, true],
  ] as const)(
    'requires the precomputed policy %s to match the provider policy %s',
    async (precomputeMode, providerMode, error) => {
      const optedOutContext = { ...context, dd_experimentation_opt_out_at: '2026-01-01T00:00:00Z' }
      const configuration = precomputeConfiguration(rules(), optedOutContext, {
        experimentationOptOutMode: precomputeMode,
      })
      const client = clientFor(new DatadogCoreProvider(configuration, { experimentationOptOutMode: providerMode }))
      const details = await client.getBooleanDetails('test-flag', false, optedOutContext)
      expect(details.errorCode).toBe(error ? 'INVALID_CONTEXT' : undefined)
      if (!error) expect(details.flagMetadata.__dd_do_log).toBe(providerMode === ExperimentationOptOutMode.Disabled)
    }
  )

  it.each([false, true])(
    'preserves consent=%s and exposes only successful matching evaluations to the tracking hook',
    async (consent) => {
      const configuration = precomputed()
      configuration.precomputed!.response.data.attributes.observeFullEvaluationData = consent
      const sink = { hasSubscribers: true, publish: jest.fn() } as unknown as jest.Mocked<Channel<ExposureEvent>>
      const provider = new DatadogCoreProvider(configuration, { exposureChannel: sink })
      const client = clientFor(provider)
      for (const evaluation of [
        client.getBooleanDetails('missing', false, context),
        client.getStringDetails('test-flag', 'default', context),
        client.getBooleanDetails('test-flag', false, { ...context, targetingKey: 'another-user' }),
      ]) {
        expect((await evaluation).flagMetadata).toMatchObject({
          __dd_eval_timestamp_ms: Date.now(),
          __dd_observe_full_evaluation_data: consent,
        })
      }
      expect(sink.publish).not.toHaveBeenCalled()
      const results = await Promise.all([
        client.getBooleanDetails('test-flag', false, context),
        client.getBooleanDetails('test-flag', false, context),
      ])
      expect(results.map((result) => result.flagMetadata.__dd_exposure_cache_hit).sort()).toEqual([false, true])
      expect(sink.publish).toHaveBeenCalledTimes(1)
      expect(results[0].flagMetadata).toMatchObject({ __dd_observe_full_evaluation_data: consent })
      provider.setConfiguration(configuration)
      await client.getBooleanValue('test-flag', false, context)
      expect(sink.publish).toHaveBeenCalledTimes(1)
      configuration.precomputed!.response.data.attributes.createdAt = new Date(Date.now() + 1).toISOString()
      provider.setConfiguration(configuration)
      await client.getBooleanValue('test-flag', false, context)
      expect(sink.publish).toHaveBeenCalledTimes(2)
    }
  )
})
