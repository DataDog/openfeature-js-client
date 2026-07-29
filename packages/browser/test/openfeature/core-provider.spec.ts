import type { FlagsConfiguration } from '@datadog/flagging-core'
import { configurationFromString } from '@datadog/flagging-core/configuration'
import type { Logger } from '@openfeature/core'
import { ProviderEvents } from '@openfeature/web-sdk'
import { CoreProvider } from '../../src/openfeature/core-provider'
import rulesWire from '../data/rules-v1-wire.json'

const logger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

const rulesConfiguration = configurationFromString(JSON.stringify(rulesWire))

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

describe('CoreProvider', () => {
  it('has browser provider metadata', () => {
    const provider = new CoreProvider({ configuration: rulesConfiguration })

    expect(provider.metadata).toEqual({ name: 'datadog-core' })
    expect(provider.runsOn).toBe('client')
  })

  it('evaluates rules locally with the supplied context', async () => {
    const provider = new CoreProvider({ configuration: rulesConfiguration })

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

  it('uses precomputed configuration only when the context matches', async () => {
    const provider = new CoreProvider({ configuration: precomputedConfiguration })

    await provider.initialize({ targetingKey: 'static-user', plan: 'free' })

    expect(
      provider.resolveStringEvaluation('static-flag', 'default', { targetingKey: 'static-user', plan: 'free' }, logger)
    ).toMatchObject({
      value: 'static-value',
      variant: 'static-variation',
      reason: 'TARGETING_MATCH',
    })
  })

  it('throws for precomputed-only context changes that do not match the configuration', async () => {
    const provider = new CoreProvider({ configuration: precomputedConfiguration })

    await provider.initialize({ targetingKey: 'static-user', plan: 'free' })

    expect(() =>
      provider.onContextChange(
        { targetingKey: 'static-user', plan: 'free' },
        { targetingKey: 'other-user', plan: 'free' }
      )
    ).toThrow('Precomputed flags configuration does not match the current context')

    expect(
      provider.resolveStringEvaluation('static-flag', 'default', { targetingKey: 'other-user', plan: 'free' }, logger)
    ).toEqual({
      value: 'default',
      reason: 'ERROR',
      errorCode: 'INVALID_CONTEXT',
    })
  })

  it('uses rules-based configuration when precomputed context does not match', async () => {
    const provider = new CoreProvider({
      configuration: {
        ...rulesConfiguration,
        precomputed: precomputedConfiguration.precomputed,
      },
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

  it('emits Ready when setConfiguration recovers from an invalid configuration', () => {
    const provider = new CoreProvider({ configuration: {} })
    const readyHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Ready, readyHandler)

    provider.setConfiguration(rulesConfiguration)

    expect(readyHandler).toHaveBeenCalledTimes(1)
  })

  it('emits ConfigurationChanged for replacement configuration', () => {
    const provider = new CoreProvider({ configuration: rulesConfiguration })
    const changedHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.ConfigurationChanged, changedHandler)

    provider.setConfiguration({
      rules: {
        ...rulesConfiguration.rules!,
        etag: 'new-rules-etag',
      },
    })

    expect(changedHandler).toHaveBeenCalledTimes(1)
  })

  it('emits Error when setConfiguration receives an invalid configuration', () => {
    const provider = new CoreProvider({ configuration: rulesConfiguration })
    const errorHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Error, errorHandler)

    provider.setConfiguration({})

    expect(errorHandler).toHaveBeenCalledTimes(1)
  })

  it('returns provider not ready when no evaluatable configuration is available', () => {
    const provider = new CoreProvider({ configuration: {} })

    expect(provider.resolveBooleanEvaluation('missing-flag', true, {}, logger)).toEqual({
      value: true,
      reason: 'ERROR',
      errorCode: 'PROVIDER_NOT_READY',
    })
  })
})
