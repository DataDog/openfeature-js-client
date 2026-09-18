import type { EvaluationContext } from '@openfeature/core'
import { matchesRule, OperatorType, type Rule } from './rules'

describe('condition attribute coercion', () => {
  it.each([
    ['an array for MATCHES', { operator: OperatorType.MATCHES, attribute: 'value', value: '^hello$' }, ['hello']],
    ['an object for NOT_MATCHES', { operator: OperatorType.NOT_MATCHES, attribute: 'value', value: '^hello$' }, {}],
    ['an object for ONE_OF', { operator: OperatorType.ONE_OF, attribute: 'value', value: ['[object Object]'] }, {}],
    ['an array for NOT_ONE_OF', { operator: OperatorType.NOT_ONE_OF, attribute: 'value', value: ['other'] }, ['hello']],
    ['an array for a numeric comparison', { operator: OperatorType.LT, attribute: 'value', value: 1.5 }, [1]],
    ['a boolean for a numeric comparison', { operator: OperatorType.LT, attribute: 'value', value: 1.5 }, true],
  ] as const)('does not coerce %s', (_description, condition, value) => {
    const rule = { conditions: [condition] } as Rule

    expect(matchesRule(rule, { value } as EvaluationContext)).toBe(false)
  })

  it.each([
    ['a bigint', BigInt(42), '42'],
    ['a Date', new Date('2026-01-01T00:00:00.000Z'), String(new Date('2026-01-01T00:00:00.000Z'))],
    ['a custom scalar-like object', { toString: () => 'custom' }, 'custom'],
  ] as const)('coerces %s to a string', (_description, value, expected) => {
    const rule = {
      conditions: [{ operator: OperatorType.ONE_OF, attribute: 'value', value: [expected] }],
    } as Rule

    expect(matchesRule(rule, { value } as EvaluationContext)).toBe(true)
  })

  it.each([
    ['positive infinity', Number.POSITIVE_INFINITY, true],
    ['a string that overflows to positive infinity', '1e400', true],
    ['NaN', Number.NaN, false],
  ] as const)('uses JavaScript numeric comparison semantics for %s', (_description, value, expected) => {
    const rule = {
      conditions: [{ operator: OperatorType.GT, attribute: 'value', value: 10 }],
    } as Rule

    expect(matchesRule(rule, { value } as EvaluationContext)).toBe(expected)
  })
})
