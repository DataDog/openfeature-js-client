import type { EvaluationContext, Logger } from '@openfeature/core'
import { evaluateRulesBasedConfiguration, type UniversalFlagConfigurationV1 } from '../../src/evaluation'

const logger: Logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const context = { targetingKey: 'subject' }
const metadataKey = '__dd_observe_full_evaluation_data'

function configuration(consent: unknown): UniversalFlagConfigurationV1 {
  return {
    createdAt: '',
    format: 'SERVER',
    environment: { name: 'test' },
    ...(consent === undefined ? {} : { observeFullEvaluationData: consent }),
    flags: {
      flag: {
        key: 'flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: { on: { key: 'on', value: true } },
        allocations: [{ key: 'all', doLog: true, splits: [{ variationKey: 'on', shards: [] }] }],
      },
    },
  } as UniversalFlagConfigurationV1
}

function evaluate(config: UniversalFlagConfigurationV1 | undefined, ctx: EvaluationContext = context) {
  return evaluateRulesBasedConfiguration(config, 'boolean', 'flag', false, ctx, logger)
}

describe('evaluation-time privacy consent', () => {
  const paths: Array<{
    name: string
    setup: (config: UniversalFlagConfigurationV1) => void
    reason: string
    errorCode?: string
    context?: EvaluationContext
  }> = [
    { name: 'success', setup: () => {}, reason: 'STATIC' },
    {
      name: 'disabled',
      setup: (c) => {
        c.flags.flag.enabled = false
      },
      reason: 'DISABLED',
    },
    {
      name: 'not found',
      setup: (c) => {
        delete c.flags.flag
      },
      reason: 'ERROR',
      errorCode: 'FLAG_NOT_FOUND',
    },
    {
      name: 'no allocation',
      setup: (c) => {
        c.flags.flag.allocations = []
      },
      reason: 'DEFAULT',
    },
    {
      name: 'type mismatch',
      setup: (c) => {
        c.flags.flag.variationType = 'STRING'
        c.flags.flag.variations.on.value = 'on'
      },
      reason: 'ERROR',
      errorCode: 'TYPE_MISMATCH',
    },
    {
      name: 'malformed flag',
      setup: (c) => {
        c.flags.flag.allocations = null as never
      },
      reason: 'ERROR',
      errorCode: 'PARSE_ERROR',
    },
    {
      name: 'missing targeting key',
      setup: (c) => {
        c.flags.flag.allocations[0].splits[0].shards = [
          { salt: 'salt', totalShards: 100, ranges: [{ start: 0, end: 100 }] },
        ]
      },
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
      context: {},
    },
    {
      name: 'evaluator exception',
      setup: (c) => {
        Object.defineProperty(c.flags.flag, 'enabled', {
          get() {
            throw new Error('pii-canary')
          },
        })
      },
      reason: 'ERROR',
      errorCode: 'GENERAL',
    },
  ]

  describe.each([true, false, undefined, null, 'true', 1, { observeFullEvaluationData: true }])(
    'root consent %p',
    (consent) => {
      it.each(paths)('stamps $name', ({ setup, reason, errorCode, context: ctx }) => {
        const config = configuration(consent)
        setup(config)
        const result = evaluate(config, ctx)
        expect(result.reason).toBe(reason)
        expect(result.errorCode).toBe(errorCode)
        expect(result.flagMetadata?.[metadataKey]).toBe(consent === true)
        expect(result.flagMetadata?.__dd_eval_timestamp_ms).toEqual(expect.any(Number))
        expect(JSON.stringify(result)).not.toContain('pii-canary')
      })
    }
  )

  it('fails closed without a configuration', () => {
    expect(evaluate(undefined)).toMatchObject({
      errorCode: 'PROVIDER_NOT_READY',
      flagMetadata: { [metadataKey]: false },
    })
  })

  it('ignores consent nested in environment metadata', () => {
    const config = configuration(undefined)
    Object.assign(config.environment, { observeFullEvaluationData: true })
    expect(evaluate(config).flagMetadata?.[metadataKey]).toBe(false)
  })

  it.each([true, false])('retains selected consent %p across a configuration swap and exception', (consent) => {
    let current = configuration(consent)
    const first = evaluate(current)
    const selected = current
    Object.defineProperty(selected.flags.flag, 'enabled', {
      get() {
        current = configuration(!consent)
        throw new Error('pii-canary')
      },
    })
    const failed = evaluate(selected)
    expect(failed.errorCode).toBe('GENERAL')
    expect(failed.flagMetadata?.[metadataKey]).toBe(consent)
    expect(first.flagMetadata?.[metadataKey]).toBe(consent)
    expect(evaluate(current).flagMetadata?.[metadataKey]).toBe(!consent)
  })

  it('captures consent before evaluator callbacks can mutate it', () => {
    const config = configuration(true)
    const mutatingLogger = {
      ...logger,
      debug: () => {
        Object.assign(config, { observeFullEvaluationData: false })
      },
    }
    const result = evaluateRulesBasedConfiguration(config, 'boolean', 'flag', false, context, mutatingLogger)
    expect(result.flagMetadata?.[metadataKey]).toBe(true)
    expect(evaluate(config).flagMetadata?.[metadataKey]).toBe(false)
  })
})
