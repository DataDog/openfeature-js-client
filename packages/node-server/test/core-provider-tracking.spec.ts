import type { Channel } from 'node:diagnostics_channel'
import type { ExposureEvent, FlagsConfiguration } from '@datadog/flagging-core'
import { type EvaluationDetails, type FlagValue, OpenFeature } from '@openfeature/server-sdk'
import rulesWire from '../../browser/test/data/rules-v1-wire.json'
import { DependencyTelemetrySidecar } from '../src/provider'
import { configurationFromString, DatadogCoreProvider, ExperimentationOptOutMode } from '../src/rules-based'

const context = { targetingKey: 'subject', country: 'US' }
const domain = 'offline-tracking'

function rules(): FlagsConfiguration {
  return configurationFromString(JSON.stringify(rulesWire))
}

function channel(hasSubscribers = true): jest.Mocked<Channel<ExposureEvent>> {
  return { hasSubscribers, publish: jest.fn() } as unknown as jest.Mocked<Channel<ExposureEvent>>
}

function clientFor(provider: DatadogCoreProvider) {
  OpenFeature.setProvider(domain, provider)
  return OpenFeature.getClient(domain)
}

function dependentRules(): FlagsConfiguration {
  const configuration = rules()
  const response = configuration.rules!.response
  const keyIndex = response.strings.push('prerequisite') - 1
  response.flags.prerequisite = structuredClone(response.flags['test-flag'])
  response.flags.prerequisite.allocations[0].targetingConditionIndex = undefined
  response.flags['test-flag'].allocations[0].targetingConditionIndex = response.conditions.length
  response.conditions.push({
    $typeName: 'datadog.ffe.flagging.ufc.v1.Condition',
    kind: {
      case: 'flagEvaluationStringMembership',
      value: {
        $typeName: 'datadog.ffe.flagging.ufc.v1.FlagEvaluationStringMembershipCondition',
        flagKeyStringIndex: keyIndex,
        variantKeyStringIndexes: [0],
        negate: false,
      },
    },
  })
  return configuration
}

describe('DatadogCoreProvider optional tracking', () => {
  beforeEach(() => {
    OpenFeature.setLogger({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() })
  })

  afterEach(async () => {
    await OpenFeature.clearProviders()
    OpenFeature.clearHooks()
    jest.restoreAllMocks()
  })

  it('does not install exposure tracking by default', async () => {
    const provider = new DatadogCoreProvider(rules())
    const client = clientFor(provider)
    expect(provider.hooks).toEqual([])
    const result = await client.getBooleanDetails('test-flag', false, context)
    expect(result).toMatchObject({ value: true, variant: 'on' })
    expect(result.flagMetadata?.__dd_do_log).toBe(true)
    expect(result.flagMetadata?.__dd_exposure_cache_hit).toBeUndefined()
  })

  it.each([true, false])('deduplicates concurrent exposures with subscribers=%s', async (hasSubscribers) => {
    const sink = channel(hasSubscribers)
    const client = clientFor(new DatadogCoreProvider(rules(), { exposureChannel: sink }))
    const results = await Promise.all([
      client.getBooleanDetails('test-flag', false, context),
      client.getBooleanDetails('test-flag', false, context),
    ])
    expect(results.map((result) => result.flagMetadata?.__dd_exposure_cache_hit).sort()).toEqual([false, true])
    expect(sink.publish).toHaveBeenCalledTimes(hasSubscribers ? 1 : 0)
    await client.getBooleanValue('test-flag', false, { ...context, targetingKey: 'another-subject' })
    expect(sink.publish).toHaveBeenCalledTimes(hasSubscribers ? 2 : 0)
  })

  it('does not record or publish an exposure after an evaluation or later hook error', async () => {
    const sink = channel()
    const client = clientFor(new DatadogCoreProvider(rules(), { exposureChannel: sink }))
    await expect(client.getBooleanDetails('missing', false, context)).resolves.toMatchObject({
      errorCode: 'FLAG_NOT_FOUND',
    })
    await expect(client.getStringDetails('test-flag', 'default', context)).resolves.toMatchObject({
      errorCode: 'TYPE_MISMATCH',
    })
    await expect(
      client.getBooleanDetails('test-flag', false, context, {
        hooks: [
          {
            after: () => {
              throw new Error('later hook failed')
            },
          },
        ],
      })
    ).resolves.toMatchObject({ errorCode: 'GENERAL' })
    expect(sink.publish).not.toHaveBeenCalled()
    const success = await client.getBooleanDetails('test-flag', false, context)
    expect(success.flagMetadata?.__dd_exposure_cache_hit).toBe(false)
    expect(sink.publish).toHaveBeenCalledTimes(1)
  })

  it('keeps telemetry failures out of flag evaluation', async () => {
    const sink = channel()
    sink.publish.mockImplementation(() => {
      throw new Error('sink unavailable')
    })
    const client = clientFor(new DatadogCoreProvider(rules(), { exposureChannel: sink }))
    await expect(client.getBooleanDetails('test-flag', false, context)).resolves.toMatchObject({
      value: true,
      variant: 'on',
    })
    expect(sink.publish).toHaveBeenCalledTimes(1)
  })

  it('preserves deduplication on identical refreshes and invalid replacements, and resets it for a new generation', async () => {
    const sink = channel()
    const provider = new DatadogCoreProvider(rules(), { exposureChannel: sink })
    const client = clientFor(provider)
    await client.getBooleanValue('test-flag', false, context)
    provider.setConfiguration(rules())
    expect(() => provider.setConfiguration({})).toThrow(TypeError)
    await client.getBooleanValue('test-flag', false, context)
    expect(sink.publish).toHaveBeenCalledTimes(1)
    const next = rules()
    next.rules!.response.createdAt!.nanos = 1
    provider.setConfiguration(next)
    await client.getBooleanValue('test-flag', false, context)
    expect(sink.publish).toHaveBeenCalledTimes(2)
  })

  it('respects experimentation opt-out without suppressing evaluation hooks', async () => {
    const sink = channel()
    const client = clientFor(
      new DatadogCoreProvider(rules(), {
        exposureChannel: sink,
        experimentationOptOutMode: ExperimentationOptOutMode.Immediate,
      })
    )
    const after = jest.fn()
    client.addHooks({ after })
    const result = await client.getBooleanDetails('test-flag', false, {
      ...context,
      dd_experimentation_opt_out_at: '2026-01-01T00:00:00Z',
    })
    expect(result).toMatchObject({
      reason: 'SPLIT',
      flagMetadata: { __dd_allocation_key: 'fallback', __dd_do_log: false },
    })
    expect(sink.publish).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('binds consent=%s to the evaluation, not a replacement configuration', async (consent) => {
    const initial = rules()
    initial.rules!.response.observeFullEvaluationData = consent
    const provider = new DatadogCoreProvider(initial)
    const client = clientFor(provider)
    const observed: unknown[] = []
    client.addHooks({
      after: (_context, details) => {
        const next = rules()
        next.rules!.response.observeFullEvaluationData = !consent
        provider.setConfiguration(next)
        observed.push(details.flagMetadata.__dd_observe_full_evaluation_data)
      },
    })
    await client.getBooleanValue('test-flag', false, context)
    expect(observed).toEqual([consent])
    const result = await client.getBooleanDetails('missing', false, context)
    expect(result.flagMetadata.__dd_observe_full_evaluation_data).toBe(!consent)
  })

  it.each([true, false])('retains dependency evaluation traces with exposure tracking=%s', async (trackExposures) => {
    const sidecar = new DependencyTelemetrySidecar()
    const sink = channel()
    const client = clientFor(
      new DatadogCoreProvider(dependentRules(), {
        dependencyTelemetrySidecar: sidecar,
        ...(trackExposures ? { exposureChannel: sink } : {}),
      })
    )
    const evaluations: string[] = []
    client.addHooks({
      finally: (hookContext, details: EvaluationDetails<FlagValue>) => {
        for (const evaluation of sidecar.takeDependencyEvaluations(details.flagMetadata, hookContext.context)) {
          evaluations.push(evaluation.flagKey)
        }
      },
    })
    await expect(client.getBooleanValue('test-flag', false, context)).resolves.toBe(true)
    expect(evaluations).toEqual(['prerequisite'])
    expect(sink.publish.mock.calls.map(([event]) => (event as ExposureEvent).flag.key)).toEqual(
      trackExposures ? ['prerequisite', 'test-flag'] : []
    )
  })
})
