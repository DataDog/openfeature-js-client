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
})
