import type { FlagsConfiguration } from '@datadog/flagging-core'
import { OpenFeature, ProviderEvents, ServerProviderStatus } from '@openfeature/server-sdk'
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
const domain = 'offline-core-provider'

function rules(value = true): FlagsConfiguration {
  const configuration = configurationFromString(JSON.stringify(rulesWire))
  configuration.rules!.response.flags['test-flag'].variations[0].value = { case: 'booleanValue', value }
  return configuration
}

function clientFor(provider: DatadogCoreProvider) {
  OpenFeature.setProvider(domain, provider)
  return OpenFeature.getClient(domain)
}

function response(configuration: FlagsConfiguration): Response {
  const wire = JSON.parse(configurationToString(configuration))
  return new Response(Buffer.from(wire.rules.response, 'base64'), {
    headers: { 'Content-Type': 'application/protobuf' },
  })
}

describe('DatadogCoreProvider offline initialization', () => {
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

  it('is ready immediately after synchronous registration and evaluates the first call without fetching', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is unavailable'))
    const ready = jest.fn()
    OpenFeature.addHandler(ProviderEvents.Ready, ready)
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)

    expect(provider.metadata.name).toBe('datadog-core')
    expect(provider.runsOn).toBe('server')
    expect('initialize' in provider).toBe(false)
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    expect(ready).toHaveBeenCalledTimes(1)
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
      variant: 'on',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('also supports awaitable registration', async () => {
    const provider = new DatadogCoreProvider(rules())
    await OpenFeature.setProviderAndWait(domain, provider)
    expect(OpenFeature.getClient(domain).providerStatus).toBe(ServerProviderStatus.READY)
  })

  it('evaluates each invocation context independently and supports optional OpenFeature hooks', async () => {
    const client = clientFor(new DatadogCoreProvider(rules()))
    const after = jest.fn()
    client.addHooks({ after })
    const first = client.getBooleanDetails('test-flag', false, context)
    const second = client.getBooleanDetails('test-flag', false, { targetingKey: 'user-2', country: 'CA' })

    await expect(first).resolves.toMatchObject({ reason: 'TARGETING_MATCH' })
    await expect(second).resolves.toMatchObject({ reason: 'SPLIT' })
    expect(after).toHaveBeenCalledTimes(2)
    expect(after.mock.calls.map(([hookContext]) => hookContext.context.targetingKey)).toEqual(['user-1', 'user-2'])
  })

  it('resolves string, number, and object values with the shared evaluator', async () => {
    const configuration = rules()
    const source = configuration.rules!.response
    const flag = source.flags['test-flag']
    const valueIndex = source.strings.push('hello') - 1
    const jsonIndex = source.jsonStrings.push(JSON.stringify({ enabled: true })) - 1
    source.flags.string = {
      ...flag,
      variationType: 1,
      variations: [{ ...flag.variations[0], value: { case: 'stringValueIndex', value: valueIndex } }],
    }
    source.flags.number = {
      ...flag,
      variationType: 3,
      variations: [{ ...flag.variations[0], value: { case: 'numericValue', value: 12.5 } }],
    }
    source.flags.object = {
      ...flag,
      variationType: 5,
      variations: [{ ...flag.variations[0], value: { case: 'jsonStringIndex', value: jsonIndex } }],
    }
    const client = clientFor(new DatadogCoreProvider(configuration))

    await expect(client.getStringValue('string', 'default', context)).resolves.toBe('hello')
    await expect(client.getNumberValue('number', 0, context)).resolves.toBe(12.5)
    await expect(client.getObjectValue('object', {}, context)).resolves.toEqual({ enabled: true })
    const value = await client.getObjectValue<{ enabled: boolean }>('object', { enabled: false }, context)
    value.enabled = false
    await expect(client.getObjectValue('object', {}, context)).resolves.toEqual({ enabled: true })
  })

  it('publishes configuration changes after the replacement is available', async () => {
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    let observed: Promise<boolean> | undefined
    const changed = jest.fn(() => {
      expect(client.providerStatus).toBe(ServerProviderStatus.READY)
      observed = client.getBooleanValue('test-flag', true, context)
    })
    client.addHandler(ProviderEvents.ConfigurationChanged, changed)

    provider.setConfiguration(rules(false))

    expect(changed).toHaveBeenCalledTimes(1)
    await expect(observed).resolves.toBe(false)
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    client.removeHandler(ProviderEvents.ConfigurationChanged, changed)
  })

  it.each([ExperimentationOptOutMode.Disabled, ExperimentationOptOutMode.Immediate])(
    'uses the existing Node experimentation policy: %s',
    async (mode) => {
      const client = clientFor(new DatadogCoreProvider(rules(), { experimentationOptOutMode: mode }))
      const details = await client.getBooleanDetails('test-flag', false, {
        ...context,
        dd_experimentation_opt_out_at: 'invalid',
      })
      expect(details.errorCode).toBe(mode === ExperimentationOptOutMode.Immediate ? 'INVALID_CONTEXT' : undefined)
    }
  )

  it('rejects unsupported experimentation policies', () => {
    expect(
      () =>
        new DatadogCoreProvider(rules(), {
          experimentationOptOutMode: 'future_experiments_only' as ExperimentationOptOutMode,
        })
    ).toThrow('experimentationOptOutMode must be disabled or immediate')
  })

  it('keeps serving the active rules while a caller-controlled refresh is in flight', async () => {
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    let complete!: (response: Response) => void
    const fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve
        })
    )
    const refresh = fetchRulesConfiguration({ apiKey: 'test-key', env: 'prod', fetch }).then((configuration) =>
      provider.setConfiguration(configuration)
    )

    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)

    complete(response(rules(false)))
    await refresh
    await expect(client.getBooleanValue('test-flag', true, context)).resolves.toBe(false)
  })

  it.each(['http', 'decode', 'transport', 'timeout'])(
    'retains the last good rules after a %s refresh failure',
    async (failure) => {
      const provider = new DatadogCoreProvider(rules())
      const client = clientFor(provider)
      const error = jest.fn()
      const changed = jest.fn()
      provider.events.addHandler(ProviderEvents.Error, error)
      provider.events.addHandler(ProviderEvents.ConfigurationChanged, changed)
      const fetch: typeof globalThis.fetch = async (_url, options) => {
        if (failure === 'transport') throw new Error('offline')
        if (failure === 'timeout') {
          return new Promise((_resolve, reject) =>
            options!.signal!.addEventListener('abort', () => reject(new Error('timeout')))
          )
        }
        return failure === 'http'
          ? new Response(null, { status: 503 })
          : new Response('invalid protobuf', { headers: { 'Content-Type': 'application/protobuf' } })
      }
      const refresh = fetchRulesConfiguration({ apiKey: 'test-key', env: 'prod', fetch, timeoutMs: 10 }).then(
        (configuration) => provider.setConfiguration(configuration)
      )
      const rejection = expect(refresh).rejects.toMatchObject({ code: failure })
      if (failure === 'timeout') await jest.advanceTimersByTimeAsync(10)
      await rejection

      expect(client.providerStatus).toBe(ServerProviderStatus.READY)
      await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
      expect(error).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    }
  )

  it.each([
    undefined,
    null,
    {},
    { rules: {} },
    { rulesError: 'Invalid rules' },
    configurationFromString('invalid wire'),
    configurationFromString(JSON.stringify({ version: 1, rules: { response: 'invalid protobuf' } })),
    precomputeConfiguration(rules(), context),
  ])('rejects unusable bootstrap data and preserves the active snapshot on an invalid update: %j', async (invalid) => {
    expect(() => new DatadogCoreProvider(invalid as FlagsConfiguration)).toThrow(TypeError)
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    const changed = jest.fn()
    provider.events.addHandler(ProviderEvents.ConfigurationChanged, changed)

    expect(() => provider.setConfiguration(invalid as FlagsConfiguration)).toThrow(TypeError)
    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    expect(changed).not.toHaveBeenCalled()
  })

  it('owns its configuration instead of exposing mutable caller state', async () => {
    const input = rules()
    const provider = new DatadogCoreProvider(input)
    const client = clientFor(provider)
    input.rules!.response.flags = {}
    const copy = provider.getConfiguration()
    copy.rules!.response.flags = {}

    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    const next = rules(false)
    provider.setConfiguration(next)
    next.rules!.response.flags = {}
    await expect(client.getBooleanValue('test-flag', true, context)).resolves.toBe(false)
  })

  it('uses rules rather than context-specific assignments in a mixed configuration', async () => {
    const configuration = rules()
    const precomputed = precomputeConfiguration(rules(false), context)
    const client = clientFor(new DatadogCoreProvider({ ...configuration, ...precomputed }))

    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    await expect(
      client.getBooleanValue('test-flag', false, { ...context, targetingKey: 'another-user' })
    ).resolves.toBe(true)
  })

  it('keeps using the last configuration as it ages without an implicit expiry', async () => {
    const configuration = configurationFromString(
      JSON.stringify({ ...rulesWire, rules: { ...rulesWire.rules, fetchedAt: Date.now() } })
    )
    const client = clientFor(new DatadogCoreProvider(configuration))

    jest.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)

    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
  })

  it('sanitizes accessor errors and keeps the active configuration', async () => {
    const invalid = Object.defineProperty({}, 'rules', {
      get() {
        throw new Error('private configuration data')
      },
    })
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)

    expect(() => new DatadogCoreProvider(invalid)).toThrow('requires a valid rules-based configuration')
    expect(() => provider.setConfiguration(invalid)).toThrow('requires a valid rules-based configuration')
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
  })

  it('accepts an intentionally empty rules configuration and preserves ordinary evaluation errors', async () => {
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    await expect(client.getStringDetails('test-flag', 'fallback', context)).resolves.toMatchObject({
      value: 'fallback',
      errorCode: 'TYPE_MISMATCH',
    })
    const empty = rules()
    empty.rules!.response.flags = {}
    provider.setConfiguration(empty)

    expect(client.providerStatus).toBe(ServerProviderStatus.READY)
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      value: false,
      errorCode: 'FLAG_NOT_FOUND',
    })
  })
})
