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
