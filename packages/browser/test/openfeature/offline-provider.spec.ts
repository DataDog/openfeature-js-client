import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/rules-based'
import type { EvaluationContext, Logger } from '@openfeature/core'
import { InvalidContextError, OpenFeature, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk'
import { DatadogOfflineProvider } from '../../src/openfeature/offline-provider'
import precomputedWire from '../data/precomputed-v1-wire.json'
import rulesWire from '../data/rules-v1-wire.json'

const logger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))
const decodedPrecomputedConfiguration = configurationFromString(JSON.stringify(precomputedWire))

const precomputedConfiguration: FlagsConfiguration = {
  precomputed: {
    context: { targetingKey: 'static-user', plan: 'free' },
    response: {
      data: {
        attributes: {
          createdAt: '2026-07-06T23:01:56.822Z',
          flags: {
            'static-flag': {
              allocationKey: 'static-allocation',
              variationKey: 'static-variation',
              variationType: 'string',
              variationValue: 'static-value',
              reason: 'TARGETING_MATCH',
              doLog: true,
            },
          },
        },
      },
    },
  },
}

function providerWithConfiguration(configuration: FlagsConfiguration): DatadogOfflineProvider {
  const provider = new DatadogOfflineProvider()
  provider.setConfiguration(configuration)
  return provider
}

describe('DatadogOfflineProvider', () => {
  it('has offline provider metadata', () => {
    const provider = providerWithConfiguration(rulesConfiguration)

    expect(provider.metadata).toEqual({ name: 'datadog-offline' })
    expect(provider.runsOn).toBe('client')
  })

  it('evaluates rules locally with the supplied context', async () => {
    const provider = providerWithConfiguration(rulesConfiguration)

    await provider.initialize({ targetingKey: 'user-1', country: 'CA' })

    expect(
      provider.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'user-1', country: 'CA' }, logger)
    ).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'SPLIT',
      flagMetadata: {
        allocationKey: 'fallback',
        doLog: false,
      },
    })

    await provider.onContextChange({ targetingKey: 'user-1', country: 'CA' }, { targetingKey: 'user-1', country: 'US' })

    expect(
      provider.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'user-1', country: 'US' }, logger)
    ).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'allocation',
        doLog: true,
      },
    })
  })

  it('stays ready and evaluates valid rules when the precomputed branch is invalid', async () => {
    const provider = providerWithConfiguration({
      precomputedError: 'Malformed precomputed data',
      rules: rulesConfiguration.rules,
    })
    const context = { targetingKey: 'user-1', country: 'US' }

    await expect(provider.initialize(context)).resolves.toBeUndefined()
    expect(provider.resolveBooleanEvaluation('test-flag', false, context, logger)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    })
  })

  it('stays ready with matching precomputed data when the rules branch is invalid', async () => {
    const provider = providerWithConfiguration({
      ...precomputedConfiguration,
      rulesError: 'Malformed rules data',
    })
    const context = { targetingKey: 'static-user', plan: 'free' }

    await expect(provider.initialize(context)).resolves.toBeUndefined()
    expect(provider.resolveStringEvaluation('static-flag', 'default', context, logger)).toMatchObject({
      value: 'static-value',
      variant: 'static-variation',
    })
  })

  it('uses a rules parse error when mismatched precomputed data cannot fall back to rules', async () => {
    const provider = providerWithConfiguration({
      ...precomputedConfiguration,
      rulesError: 'Malformed rules data',
    })
    const context = { targetingKey: 'other-user' }

    await expect(provider.initialize(context)).rejects.toMatchObject({ code: 'PARSE_ERROR' })
    expect(provider.resolveStringEvaluation('static-flag', 'default', context, logger)).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Malformed rules data',
    })
  })

  it('uses precomputed configuration only when the context matches', async () => {
    const provider = providerWithConfiguration(precomputedConfiguration)

    await provider.initialize({ targetingKey: 'static-user', plan: 'free' })

    expect(
      provider.resolveStringEvaluation('static-flag', 'default', { targetingKey: 'static-user', plan: 'free' }, logger)
    ).toMatchObject({
      value: 'static-value',
      variant: 'static-variation',
      reason: 'TARGETING_MATCH',
    })
  })

  it('adopts the context embedded in decoded precomputed configuration when initialized without a context', async () => {
    const provider = new DatadogOfflineProvider({ configuration: decodedPrecomputedConfiguration })

    await expect(provider.initialize({})).resolves.toBeUndefined()

    expect(provider.resolveStringEvaluation('string-flag', 'default', {}, logger)).toMatchObject({
      value: 'red',
      variant: 'variation-123',
      reason: 'TARGETING_MATCH',
    })
  })

  it('treats a context containing only undefined values as empty', async () => {
    const provider = new DatadogOfflineProvider({ configuration: precomputedConfiguration })
    const emptyContext = { targetingKey: undefined } as unknown as EvaluationContext

    await expect(provider.initialize(emptyContext)).resolves.toBeUndefined()

    expect(provider.resolveStringEvaluation('static-flag', 'default', emptyContext, logger)).toMatchObject({
      value: 'static-value',
      variant: 'static-variation',
      reason: 'TARGETING_MATCH',
    })
  })

  it('throws for precomputed-only context changes that do not match the configuration', async () => {
    const provider = providerWithConfiguration(precomputedConfiguration)

    await provider.initialize({ targetingKey: 'static-user', plan: 'free' })

    expect(() => {
      provider.onContextChange(
        { targetingKey: 'static-user', plan: 'free' },
        { targetingKey: 'other-user', plan: 'free' }
      )
    }).toThrow(InvalidContextError)

    expect(
      provider.resolveStringEvaluation('static-flag', 'default', { targetingKey: 'other-user', plan: 'free' }, logger)
    ).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT',
      errorMessage: 'Precomputed flags configuration does not match the current context',
    })
  })

  it('uses rules-based configuration when precomputed context does not match', async () => {
    const provider = providerWithConfiguration({
      ...rulesConfiguration,
      precomputed: precomputedConfiguration.precomputed,
    })

    await provider.initialize({ targetingKey: 'other-user', country: 'US' })

    expect(
      provider.resolveBooleanEvaluation('test-flag', false, { targetingKey: 'other-user', country: 'US' }, logger)
    ).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    })
  })

  it('accepts configuration before registration and validates it against the initialization context', async () => {
    const provider = new DatadogOfflineProvider()
    const errorHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, errorHandler)

    provider.setConfiguration(precomputedConfiguration)

    expect(errorHandler).not.toHaveBeenCalled()
    try {
      await expect(
        OpenFeature.setProviderAndWait('offline-provider-ordering', provider, {
          targetingKey: 'static-user',
          plan: 'free',
        })
      ).resolves.toBeUndefined()
      expect(errorHandler).not.toHaveBeenCalled()
    } finally {
      await OpenFeature.clearProviders()
    }
  })

  it('emits Ready when setConfiguration recovers from an invalid configuration', async () => {
    const provider = new DatadogOfflineProvider()
    const readyHandler = jest.fn()
    const changedHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Ready, readyHandler)
    provider.events.addHandler(ProviderEvents.ConfigurationChanged, changedHandler)
    await expect(provider.initialize({})).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' })

    provider.setConfiguration(rulesConfiguration)

    expect(readyHandler).toHaveBeenCalledTimes(1)
    expect(changedHandler).toHaveBeenCalledTimes(1)
  })

  it('emits ConfigurationChanged for replacement configuration', async () => {
    const provider = providerWithConfiguration(rulesConfiguration)
    const changedHandler = jest.fn()
    await provider.initialize({})
    provider.events.addHandler(ProviderEvents.ConfigurationChanged, changedHandler)

    provider.setConfiguration({
      rules: {
        ...rulesConfiguration.rules!,
        etag: 'new-rules-etag',
      },
    })

    expect(changedHandler).toHaveBeenCalledTimes(1)
  })

  it('emits Error when setConfiguration receives an invalid configuration', async () => {
    const provider = providerWithConfiguration(rulesConfiguration)
    const errorHandler = jest.fn()
    await provider.initialize({})
    provider.events.addHandler(ProviderEvents.Error, errorHandler)

    provider.setConfiguration({})

    expect(errorHandler).toHaveBeenCalledWith({
      message: 'Flags configuration contains no usable capability',
      errorCode: 'PARSE_ERROR',
    })
    expect(provider.resolveBooleanEvaluation('missing-flag', true, {}, logger)).toMatchObject({
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Flags configuration contains no usable capability',
    })
  })

  it('uses parse errors for malformed configured capabilities', async () => {
    const provider = new DatadogOfflineProvider()
    const errorHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, errorHandler)
    provider.setConfiguration({ rulesError: 'Malformed rules data' })

    expect(errorHandler).not.toHaveBeenCalled()
    await expect(provider.initialize({})).rejects.toMatchObject({ code: 'PARSE_ERROR' })
    expect(provider.resolveBooleanEvaluation('missing-flag', true, {}, logger)).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
      errorMessage: 'Malformed rules data',
    })
  })

  it('returns provider not ready when no evaluatable configuration is available', () => {
    const provider = new DatadogOfflineProvider()

    expect(provider.resolveBooleanEvaluation('missing-flag', true, {}, logger)).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY',
      errorMessage: 'No flags configuration has been set',
    })
  })

  it('throws ProviderNotReadyError when initialized without evaluatable configuration', async () => {
    const provider = new DatadogOfflineProvider({ configuration: {} })

    await expect(provider.initialize({})).rejects.toBeInstanceOf(ProviderNotReadyError)
  })
})

describe('DatadogOfflineProvider precomputed lifecycle', () => {
  beforeEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    await OpenFeature.clearContext()
    OpenFeature.clearHandlers()
  })

  it('recovers the embedded context after the OpenFeature context is cleared', async () => {
    const provider = new DatadogOfflineProvider({ configuration: precomputedConfiguration })
    await OpenFeature.setProviderAndWait(provider)
    const client = OpenFeature.getClient()

    expect(client.getStringValue('static-flag', 'default')).toBe('static-value')

    await OpenFeature.setContext({ targetingKey: 'other-user', plan: 'free' })

    const errorHandler = jest.fn()
    OpenFeature.addHandler(ProviderEvents.Error, errorHandler)
    expect(errorHandler).toHaveBeenCalledTimes(1)
    expect(client.getStringDetails('static-flag', 'default')).toMatchObject({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT',
    })

    await OpenFeature.clearContext()

    const readyHandler = jest.fn()
    OpenFeature.addHandler(ProviderEvents.Ready, readyHandler)

    expect(readyHandler).toHaveBeenCalledTimes(1)
    expect(client.getStringValue('static-flag', 'default')).toBe('static-value')
  })
})
