import { createHash } from 'node:crypto'
import type { EvaluationContext, EvaluationDetails } from '@openfeature/core'
import { FlagEvaluationAggregator } from '../../src/configuration/flagEvaluationAggregator'
import type { FlagEvaluationEvent } from '../../src/configuration/flagEvaluationEvent.types'
import * as sha256 from '../../src/evaluation/sha256'

const subject = 'jane.doe@datadoghq.com'
const canonicalHash = 'sha256_b4698f9b6d186781fa8dc59e533578fa2d8379a46b1cf6db85cda6aa9c99e51b'
const codes = [
  'PROVIDER_NOT_READY',
  'PROVIDER_FATAL',
  'FLAG_NOT_FOUND',
  'PARSE_ERROR',
  'TYPE_MISMATCH',
  'TARGETING_KEY_MISSING',
  'INVALID_CONTEXT',
  'GENERAL',
]
const details = (consent: unknown): EvaluationDetails<boolean> => ({
  flagKey: 'flag',
  value: true,
  variant: 'on',
  reason: 'STATIC',
  flagMetadata: { __dd_observe_full_evaluation_data: consent as boolean, doLog: false },
})
let events: FlagEvaluationEvent[]
let aggregator: FlagEvaluationAggregator
beforeEach(() => {
  events = []
  aggregator = new FlagEvaluationAggregator(100, (batch) => events.push(...batch))
})
afterEach(() => {
  aggregator.stop()
  jest.restoreAllMocks()
})

it.each([true, false, undefined, null, 'true', 1, [], {}])(
  'protects telemetry unless consent is literal true (%p)',
  (consent) => {
    const context = { targetingKey: subject, email: 'private@example.com', nested: { secret: 'private-context' } }
    const result = details(consent)
    aggregator.addEvaluation(context, result)
    // Mutation of the input/result after enqueue must not change the captured data.
    context.targetingKey = 'changed@example.com'
    context.nested.secret = 'changed-context'
    result.flagMetadata.__dd_observe_full_evaluation_data = consent !== true
    aggregator.flush()
    expect(events).toHaveLength(1)
    expect(events[0].targeting_key).toBe(consent === true ? subject : canonicalHash)
    expect(events[0].evaluation_count).toBe(1)
    if (consent === true)
      expect(events[0].context?.evaluation).toEqual({
        email: 'private@example.com',
        nested: { secret: 'private-context' },
      })
    else {
      expect(events[0].context).toBeUndefined()
      expect(JSON.stringify(events)).not.toContain('private')
      expect(JSON.stringify(events)).not.toContain(subject)
    }
  }
)

it.each(['', 'café', 'cafe\u0301', '🚲/旗', 'a\0b', '  subject  ', '\ufffd', 'sha256_already-prefixed'])(
  'hashes exact UTF-8 without normalization: %p',
  (targetingKey) => {
    aggregator.addEvaluation({ targetingKey }, details(false))
    aggregator.flush()
    expect(events[0].targeting_key).toBe(
      targetingKey === '' ? '' : `sha256_${createHash('sha256').update(targetingKey, 'utf8').digest('hex')}`
    )
  }
)

it.each([undefined, null, 1, true, {}, ['subject'], '\ud800', '\udfff', 'a\ud800b'])(
  'omits invalid targeting key without losing the evaluation: %p',
  (targetingKey) => {
    aggregator.addEvaluation({ targetingKey } as EvaluationContext, details(false))
    aggregator.flush()
    expect(events[0]).not.toHaveProperty('targeting_key')
    expect(events[0].evaluation_count).toBe(1)
  }
)

it('does not read discarded context or use it to split protected aggregation', () => {
  const context = {
    targetingKey: subject,
    get privateAttribute(): string {
      throw new Error('private getter')
    },
  }
  aggregator.addEvaluation(context, details(false))
  aggregator.addEvaluation({ targetingKey: subject, privateAttribute: 'different' }, details(false))
  aggregator.flush()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ targeting_key: canonicalHash, evaluation_count: 2 })
})

it('keeps consent buckets and empty/missing targeting keys separate', () => {
  for (const consent of [true, false, true, false]) {
    aggregator.addEvaluation({ targetingKey: '' }, details(consent))
    aggregator.addEvaluation({}, details(consent))
  }
  aggregator.flush()
  expect(events).toHaveLength(4)
  expect(events.every((event) => event.evaluation_count === 2)).toBe(true)
  expect(events.filter((event) => event.targeting_key === '')).toHaveLength(2)
  expect(events.filter((event) => !('targeting_key' in event))).toHaveLength(2)
})

it.each([true, false])('uses only stable errors in consent mode %s', (consent) => {
  for (const error of [...codes, 'email=private@example.com', '', null, { code: 'secret' }]) {
    aggregator.addEvaluation(
      { targetingKey: subject },
      { ...details(consent), variant: undefined, reason: 'ERROR', errorMessage: 'raw exception secret' },
      error as string
    )
  }
  aggregator.addEvaluation(
    {},
    { ...details(consent), reason: 'ERROR', errorCode: 'private-code' as never, errorMessage: 'private-message' }
  )
  aggregator.addEvaluation({}, { ...details(consent), reason: 'ERROR' })
  aggregator.addEvaluation({}, details(consent))
  aggregator.flush()
  expect(events.reduce((sum, event) => sum + event.evaluation_count, 0)).toBe(15)
  expect(events.filter((event) => event.error).every((event) => codes.includes(event.error!.message))).toBe(true)
  expect(JSON.stringify(events)).not.toContain('secret')
  expect(JSON.stringify(events)).not.toContain('private')
  expect(events.some((event) => !event.error)).toBe(true)
  expect(
    events.filter((event) => event.runtime_default_used).reduce((sum, event) => sum + event.evaluation_count, 0)
  ).toBe(12)
})

it('keeps counts when full-data context cannot be serialized', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  aggregator.addEvaluation({ targetingKey: subject, cyclic } as EvaluationContext, details(true))
  aggregator.flush()
  expect(events[0]).toMatchObject({ targeting_key: subject, evaluation_count: 1 })
  expect(events[0]).not.toHaveProperty('context')
})

it('does not fall back to raw text or drop evaluations on hash failure', () => {
  jest.spyOn(sha256, 'sha256Hex').mockImplementation(() => {
    throw new Error('hash unavailable')
  })
  aggregator.addEvaluation({ targetingKey: subject }, details(false))
  aggregator.stop()
  expect(events[0]).toMatchObject({ evaluation_count: 1 })
  expect(events[0]).not.toHaveProperty('targeting_key')
})
