import type { EvaluationContext } from '@openfeature/core'
import { isValidRule, matchesRule, OperatorType, type Rule } from './rules'

describe('SHA-256 membership conditions', () => {
  const hash = 'c0e551d80aa1e2cb1eaf5be7edbb04e51eb1823e562e2ce5dfeda0ecba76c744'

  it('matches the hash of salt bytes followed by the UTF-8 attribute value', () => {
    const rule: Rule = {
      conditions: [
        {
          operator: OperatorType.ONE_OF_SHA256,
          attribute: 'name',
          value: { salt: [1, 2], hashes: [hash] },
        },
      ],
    }

    expect(isValidRule(rule)).toBe(true)
    expect(matchesRule(rule, { name: 'hello' })).toBe(true)
  })

  it('supports negative membership', () => {
    const rule: Rule = {
      conditions: [
        {
          operator: OperatorType.NOT_ONE_OF_SHA256,
          attribute: 'name',
          value: { salt: [1, 2], hashes: [hash] },
        },
      ],
    }

    expect(matchesRule(rule, { name: 'other' })).toBe(true)
    expect(matchesRule(rule, { name: 'hello' })).toBe(false)
  })
})

describe('condition attribute coercion', () => {
  const hash = 'c0e551d80aa1e2cb1eaf5be7edbb04e51eb1823e562e2ce5dfeda0ecba76c744'

  it.each([
    ['an array for MATCHES', { operator: OperatorType.MATCHES, attribute: 'value', value: '^hello$' }, ['hello']],
    ['an object for NOT_MATCHES', { operator: OperatorType.NOT_MATCHES, attribute: 'value', value: '^hello$' }, {}],
    ['an object for ONE_OF', { operator: OperatorType.ONE_OF, attribute: 'value', value: ['[object Object]'] }, {}],
    ['an array for NOT_ONE_OF', { operator: OperatorType.NOT_ONE_OF, attribute: 'value', value: ['other'] }, ['hello']],
    [
      'an array for ONE_OF_SHA256',
      { operator: OperatorType.ONE_OF_SHA256, attribute: 'value', value: { salt: [1, 2], hashes: [hash] } },
      ['hello'],
    ],
    [
      'an object for NOT_ONE_OF_SHA256',
      { operator: OperatorType.NOT_ONE_OF_SHA256, attribute: 'value', value: { salt: [1, 2], hashes: [hash] } },
      {},
    ],
    ['an array for a numeric comparison', { operator: OperatorType.LT, attribute: 'value', value: 1.5 }, [1]],
    ['a boolean for a numeric comparison', { operator: OperatorType.LT, attribute: 'value', value: 1.5 }, true],
  ] as const)('does not coerce %s', (_description, condition, value) => {
    const rule = { conditions: [condition] } as Rule

    expect(matchesRule(rule, { value } as EvaluationContext)).toBe(false)
  })
})
