import { channel } from 'node:diagnostics_channel'
import { evaluate } from '@datadog/flagging-core'
import wire from '../../browser/test/data/rules-v1-wire.json'
import {
  ConfigurationPrecomputeError,
  configurationFromString,
  configurationToString,
  fetchRulesConfiguration,
  precomputeConfiguration,
} from '../src/rules-based'

describe('standalone precomputation', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('accepts fetched rules directly, makes no additional requests and emits no tracking', async () => {
    const requestFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from(wire.rules.response, 'base64'), {
        headers: { 'Content-Type': 'application/protobuf', ETag: wire.rules.etag },
      })
    )
    const exposure = channel('dd-trace:openfeature:exposure')
    const evaluation = channel('dd-trace:openfeature:evaluation')
    const track = jest.fn()
    exposure.subscribe(track)
    evaluation.subscribe(track)
    try {
      const rules = await fetchRulesConfiguration({
        distributionChannel: 'client',
        clientToken: 'test-token',
        env: 'prod',
      })
      for (const country of ['US', 'CA']) {
        const context = { targetingKey: 'subject', country }
        const result = configurationFromString(configurationToString(precomputeConfiguration(rules, context)))
        expect(Object.keys(result)).toEqual(['precomputed'])
        expect(result.precomputed?.etag).toBeUndefined()
        expect(evaluate(result, 'boolean', 'test-flag', false, context)).toMatchObject({
          value: true,
          variant: 'on',
          reason: country === 'US' ? 'TARGETING_MATCH' : 'SPLIT',
        })
      }
      expect(requestFetch).toHaveBeenCalledTimes(1)
      expect(track).not.toHaveBeenCalled()
    } finally {
      exposure.unsubscribe(track)
      evaluation.unsubscribe(track)
    }
  })

  it('exposes a typed input error instead of converting malformed wires into an empty snapshot', () => {
    const malformed = configurationFromString('not a configuration')
    expect(() => precomputeConfiguration(malformed, {})).toThrow(ConfigurationPrecomputeError)
    expect(() => precomputeConfiguration(malformed, {})).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' })
    )
  })
})
