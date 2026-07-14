import { type FlagsConfiguration, OperatorType } from '@datadog/flagging-core'
import type { Logger } from '@openfeature/core'
import { ProviderEvents } from '@openfeature/web-sdk'
import { CoreProvider } from '../../src/openfeature/core-provider'

const logger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

const rulesBasedConfiguration: FlagsConfiguration = {
  rulesBased: {
    response: {
      createdAt: '2026-07-06T23:01:56.822Z',
      format: 'SERVER',
      environment: {
        name: 'prod',
      },
      flags: {
        'dynamic-flag': {
          key: 'dynamic-flag',
          enabled: true,
          variationType: 'STRING',
          variations: {
            enterprise: { key: 'enterprise', value: 'enabled' },
            fallback: { key: 'fallback', value: 'disabled' },
          },
          allocations: [
            {
              key: 'enterprise-allocation',
              rules: [
                {
                  conditions: [{ operator: OperatorType.ONE_OF, attribute: 'plan', value: ['enterprise'] }],
                },
              ],
              doLog: true,
              splits: [
                {
                  variationKey: 'enterprise',
                  extraLogging: { experiment: 'dynamic-context' },
                  shards: [{ salt: 'salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
                },
              ],
            },
            {
              key: 'fallback-allocation',
              doLog: false,
              splits: [
                {
                  variationKey: 'fallback',
                  shards: [{ salt: 'salt', ranges: [{ start: 0, end: 10000 }], totalShards: 10000 }],
                },
              ],
            },
          ],
        },
      },
    },
    etag: 'rules-etag',
  },
}

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
              extraLogging: { experiment: 'static-context' },
            },
          },
        },
      },
    },
  },
}

describe('CoreProvider', () => {
  it('has browser provider metadata', () => {
    const provider = new CoreProvider({ configuration: rulesBasedConfiguration })

    expect(provider.metadata).toEqual({ name: 'datadog-core' })
    expect(provider.runsOn).toBe('client')
  })

  it('evaluates rules locally with the supplied context', async () => {
    const provider = new CoreProvider({ configuration: rulesBasedConfiguration })

    await provider.initialize({ targetingKey: 'user-1', plan: 'free' })

    expect(
      provider.resolveStringEvaluation('dynamic-flag', 'default', { targetingKey: 'user-1', plan: 'free' }, logger)
    ).toMatchObject({
      value: 'disabled',
      variant: 'fallback',
      reason: 'TARGETING_MATCH',
    })

    await provider.onContextChange(
      { targetingKey: 'user-1', plan: 'free' },
      { targetingKey: 'user-1', plan: 'enterprise' }
    )

    expect(
      provider.resolveStringEvaluation(
        'dynamic-flag',
        'default',
        { targetingKey: 'user-1', plan: 'enterprise' },
        logger
      )
    ).toMatchObject({
      value: 'enabled',
      variant: 'enterprise',
      reason: 'TARGETING_MATCH',
      flagMetadata: {
        allocationKey: 'enterprise-allocation',
        doLog: true,
        extraLogging: { experiment: 'dynamic-context' },
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
        ...rulesBasedConfiguration,
        precomputed: precomputedConfiguration.precomputed,
      },
    })

    await provider.initialize({ targetingKey: 'other-user', plan: 'enterprise' })

    expect(
      provider.resolveStringEvaluation(
        'dynamic-flag',
        'default',
        { targetingKey: 'other-user', plan: 'enterprise' },
        logger
      )
    ).toMatchObject({
      value: 'enabled',
      variant: 'enterprise',
      reason: 'TARGETING_MATCH',
    })
  })

  it('emits Ready when setConfiguration recovers from an invalid configuration', () => {
    const provider = new CoreProvider({ configuration: {} })
    const readyHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.Ready, readyHandler)

    provider.setConfiguration(rulesBasedConfiguration)

    expect(readyHandler).toHaveBeenCalledTimes(1)
  })

  it('emits ConfigurationChanged for replacement configuration', () => {
    const provider = new CoreProvider({ configuration: rulesBasedConfiguration })
    const changedHandler = jest.fn()
    provider.events.addHandler(ProviderEvents.ConfigurationChanged, changedHandler)

    provider.setConfiguration({
      rulesBased: {
        ...rulesBasedConfiguration.rulesBased!,
        etag: 'new-rules-etag',
      },
    })

    expect(changedHandler).toHaveBeenCalledTimes(1)
  })

  it('emits Error when setConfiguration receives an invalid configuration', () => {
    const provider = new CoreProvider({ configuration: rulesBasedConfiguration })
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
